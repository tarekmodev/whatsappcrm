import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  TicketResponseSchema,
  permissionsForRole,
  type Permission,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { ANONYMOUS, PRINCIPAL_SOURCE, resolved } from '../rbac/principal.source';
import { TicketCommandService } from './ticket-command.service';
import { TicketQueryService } from './ticket-query.service';
import { TicketsController } from './tickets.controller';
import {
  TicketCloseNotPermittedError,
  TicketNotFoundError,
  TicketStatusChangedConcurrentlyError,
  TicketTransitionNotAllowedError,
} from './tickets.errors';

/**
 * The HTTP contract of the three ticket routes.
 *
 * Proved with the **real** `PrincipalGuard` and `PermissionGuard`, registered as
 * `APP_GUARD` the way `RequestPipelineModule` registers them (TAR-58), and a
 * fake principal source in place of the session read — the same harness
 * `conversations.controller.spec.ts` uses, for the same reason: the load-bearing
 * assertion in each block is that an unauthenticated or under-permissioned
 * caller never reaches a service.
 *
 * ## Why the query binding is asserted here and not only in the contract
 *
 * `GET /tickets` takes its filters from a **query string**, so every value
 * reaches the schema as characters. A schema that is correct against a
 * hand-built object and wrong against `?breachedOnly=true` is a schema that
 * passes its own unit test and 400s in production — which is exactly what
 * happened to `breachedOnly`. These cases go through Express, the pipe and the
 * schema together, which is the only place that gap is visible.
 */

const TENANT = '25444444-4444-7444-8444-444444444401';
const TICKET = '25444444-4444-7444-8444-4444444444f1';

function principalWith(permissions: readonly Permission[]): SessionPrincipal {
  return {
    userId: '25444444-4444-7444-8444-4444444444d1',
    tenantId: TENANT,
    email: 'agent@example.invalid',
    displayName: 'Ada Agent',
    role: 'agent',
    permissions: [...permissions],
    teamIds: [],
    sessionId: '25444444-4444-7444-8444-4444444444e1',
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

const AGENT = principalWith(permissionsForRole('agent'));

const TICKET_RESPONSE = {
  id: TICKET,
  number: 41,
  conversationId: '25444444-4444-7444-8444-4444444444e1',
  contactId: '25444444-4444-7444-8444-4444444444c1',
  subject: null,
  status: 'open' as const,
  priority: 'normal' as const,
  assignedUserId: AGENT.userId,
  assignedTeamId: null,
  // The column default: routing has reached no conclusion on this ticket, and
  // will not until TAR-288's router runs.
  routing: {
    state: 'pending' as const,
    deferredReason: null,
    deferredSince: null,
  },
  sla: {
    policyId: null,
    firstResponseState: 'not_applicable' as const,
    firstResponseDueAt: null,
    resolutionState: 'not_applicable' as const,
    resolutionDueAt: null,
  },
  firstRespondedAt: null,
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-08-11T09:00:00.000Z',
  updatedAt: '2026-08-11T09:00:00.000Z',
};

describe('ticket routes', () => {
  let app: INestApplication;
  let server: Server;
  let signedIn: boolean;
  let principal: SessionPrincipal;

  let list: jest.Mock;
  let get: jest.Mock;
  let update: jest.Mock;

  beforeAll(async () => {
    list = jest.fn();
    get = jest.fn();
    update = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [TicketsController],
      providers: [
        ApiExceptionFilter,
        { provide: TicketQueryService, useValue: { list, get } },
        { provide: TicketCommandService, useValue: { update } },
        // Read by `configureApp` for the CORS allow-list; nothing here needs it.
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PRINCIPAL_SOURCE,
          useValue: { resolve: () => Promise.resolve(signedIn ? resolved(principal) : ANONYMOUS) },
        },
        { provide: APP_GUARD, useClass: PrincipalGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    const middleware = app.get(TenantContextMiddleware);
    const tenantContext = app.get(TenantContextService);

    app.use((req: unknown, res: unknown, next: () => void) => {
      (middleware as { use: (a: unknown, b: unknown, c: () => void) => void }).use(req, res, () => {
        tenantContext.setTenant(TENANT);
        next();
      });
    });

    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    signedIn = true;
    principal = AGENT;
  });

  describe('GET /api/v1/tickets', () => {
    it('refuses an unauthenticated caller before reaching the service', async () => {
      signedIn = false;

      const response = await request(server).get('/api/v1/tickets').expect(401);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
      expect(list).not.toHaveBeenCalled();
    });

    it('refuses a caller without ticket:read', async () => {
      principal = principalWith(
        permissionsForRole('agent').filter((permission) => permission !== 'ticket:read'),
      );

      await request(server).get('/api/v1/tickets').expect(403);
      expect(list).not.toHaveBeenCalled();
    });

    it('returns the page, and parses the published shape', async () => {
      list.mockResolvedValue({ items: [TICKET_RESPONSE], nextCursor: null });

      const response = await request(server).get('/api/v1/tickets').expect(200);
      const page = response.body as { items: unknown[] };

      expect(TicketResponseSchema.parse(page.items[0]).id).toBe(TICKET);
    });

    it('applies the schema defaults rather than passing the raw query through', async () => {
      list.mockResolvedValue({ items: [], nextCursor: null });

      await request(server).get('/api/v1/tickets').expect(200);

      expect(list).toHaveBeenCalledWith({ limit: 25, scope: 'assigned', breachedOnly: false });
    });

    it('binds ?breachedOnly=true out of the query string', async () => {
      // The supervisor's breached-ticket landing view. Every value in a query
      // string is characters, so a plain `z.boolean()` here answered
      // `validation_failed` for the one query this filter exists to serve.
      list.mockResolvedValue({ items: [], nextCursor: null });

      await request(server).get('/api/v1/tickets?breachedOnly=true').expect(200);

      expect(list).toHaveBeenCalledWith(expect.objectContaining({ breachedOnly: true }));
    });

    it('reads ?breachedOnly=false as off, not as a non-empty string', async () => {
      // The trap `z.coerce.boolean()` would have walked into: `Boolean('false')`
      // is `true`, so turning the filter off would have turned it on.
      list.mockResolvedValue({ items: [], nextCursor: null });

      await request(server).get('/api/v1/tickets?breachedOnly=false').expect(200);

      expect(list).toHaveBeenCalledWith(expect.objectContaining({ breachedOnly: false }));
    });

    it('refuses a breachedOnly that is not a boolean token', async () => {
      const response = await request(server)
        .get('/api/v1/tickets?breachedOnly=perhaps')
        .expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(list).not.toHaveBeenCalled();
    });

    it('coerces limit and keeps its published ceiling', async () => {
      list.mockResolvedValue({ items: [], nextCursor: null });

      await request(server).get('/api/v1/tickets?limit=50&status=resolved').expect(200);
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, status: 'resolved' }));

      await request(server).get('/api/v1/tickets?limit=500').expect(400);
    });
  });

  describe('GET /api/v1/tickets/{id}', () => {
    it('refuses an id that is not a UUID before looking anything up', async () => {
      // It would otherwise reach a `@db.Uuid` column as a driver error — a 500
      // for input that deserves a 400.
      const response = await request(server).get('/api/v1/tickets/not-a-uuid').expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(get).not.toHaveBeenCalled();
    });

    it('answers not_found for a ticket this principal may not see', async () => {
      get.mockRejectedValue(new TicketNotFoundError(TICKET));

      const response = await request(server).get(`/api/v1/tickets/${TICKET}`).expect(404);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
    });
  });

  describe('PATCH /api/v1/tickets/{id}', () => {
    it('refuses a caller without ticket:update', async () => {
      principal = principalWith(
        permissionsForRole('agent').filter((permission) => permission !== 'ticket:update'),
      );

      await request(server)
        .patch(`/api/v1/tickets/${TICKET}`)
        .send({ priority: 'urgent' })
        .expect(403);
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses a body with no field set', async () => {
      const response = await request(server)
        .patch(`/api/v1/tickets/${TICKET}`)
        .send({})
        .expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(update).not.toHaveBeenCalled();
    });

    it('returns the updated ticket', async () => {
      update.mockResolvedValue({ ...TICKET_RESPONSE, status: 'pending' });

      const response = await request(server)
        .patch(`/api/v1/tickets/${TICKET}`)
        .send({ status: 'pending' })
        .expect(200);

      expect(TicketResponseSchema.parse(response.body).status).toBe('pending');
      expect(update).toHaveBeenCalledWith(TICKET, { status: 'pending' });
    });

    it('maps a refused transition to conflict', async () => {
      update.mockRejectedValue(new TicketTransitionNotAllowedError(TICKET, 'resolved', 'open'));

      const response = await request(server)
        .patch(`/api/v1/tickets/${TICKET}`)
        .send({ status: 'open' })
        .expect(409);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('conflict');
    });

    it('maps a lost compare-and-set to conflict as well', async () => {
      // Same answer as a refused transition, and deliberately: to a client both
      // mean "the row's state refused a well-formed request — refetch".
      update.mockRejectedValue(new TicketStatusChangedConcurrentlyError(TICKET, 'pending'));

      const response = await request(server)
        .patch(`/api/v1/tickets/${TICKET}`)
        .send({ status: 'resolved' })
        .expect(409);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('conflict');
    });

    it('maps a missing ticket:close to forbidden, not not_found', async () => {
      // The one place this module answers 403 rather than 404: the caller has
      // already passed the visibility check, so the ticket's existence is not a
      // secret from them — what they may not do is finish it.
      update.mockRejectedValue(new TicketCloseNotPermittedError('resolved'));

      const response = await request(server)
        .patch(`/api/v1/tickets/${TICKET}`)
        .send({ status: 'resolved' })
        .expect(403);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('forbidden');
    });
  });
});
