import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  TicketEscalationResponseSchema,
  TicketResponseSchema,
  permissionsForRole,
  type Permission,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { ANONYMOUS, PRINCIPAL_SOURCE, resolved } from '../rbac/principal.source';
import { TicketCommandService } from './ticket-command.service';
import { TicketEventQueryService } from './ticket-event-query.service';
import { TicketQueryService } from './ticket-query.service';
import { TicketsController } from './tickets.controller';
import {
  TicketCloseNotPermittedError,
  TicketHandoffNotPermittedError,
  TicketNotFoundError,
  TicketReasonRequiredError,
  TicketStatusChangedConcurrentlyError,
  TicketTransitionNotAllowedError,
  UnknownTicketAssigneeError,
} from './tickets.errors';

/**
 * The HTTP contract of the four ticket routes.
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
/** `ticket:assign` is supervisor-and-above (0004), so the assign route needs one. */
const SUPERVISOR: SessionPrincipal = {
  ...principalWith(permissionsForRole('supervisor')),
  role: 'supervisor',
};
const TEAMMATE = '25444444-4444-7444-8444-4444444444d2';

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
  let assign: jest.Mock;
  let escalate: jest.Mock;
  let listEvents: jest.Mock;
  let execute: jest.Mock;

  beforeAll(async () => {
    list = jest.fn();
    get = jest.fn();
    update = jest.fn();
    assign = jest.fn();
    escalate = jest.fn();
    listEvents = jest.fn();
    // The generic middleware, stubbed to run its work and report a first
    // execution. What the header *does* is `idempotency.service.spec.ts`'s
    // business; what this file asserts is that the route reaches it at all, and
    // only when a key was sent.
    execute = jest.fn(async (_request: unknown, work: () => Promise<unknown>) => ({
      statusCode: 200,
      body: await work(),
      replayed: false,
    }));

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [TicketsController],
      providers: [
        ApiExceptionFilter,
        { provide: TicketQueryService, useValue: { list, get } },
        { provide: TicketCommandService, useValue: { update, assign, escalate } },
        { provide: TicketEventQueryService, useValue: { list: listEvents } },
        { provide: IdempotencyService, useValue: { execute } },
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

  describe('POST /api/v1/tickets/{id}/assign', () => {
    const path = `/api/v1/tickets/${TICKET}/assign`;

    beforeEach(() => {
      principal = SUPERVISOR;
    });

    it('admits an agent, because the route declares ticket:handoff', async () => {
      // TAR-32's first acceptance criterion opens "as an agent", and ADR 0011
      // decision 2 resolves it by declaring the weaker permission here and
      // applying the bound in the service. An agent reaching the service is
      // therefore the correct behaviour — and the *bound* is what stops them
      // taking a colleague's ticket, asserted in the service spec and against a
      // real database in `ticket-handoff.int-spec.ts`.
      principal = AGENT;
      assign.mockResolvedValue(TICKET_RESPONSE);

      await request(server)
        .post(path)
        .send({ userId: TEAMMATE, reason: 'Going off shift' })
        .expect(200);

      expect(assign).toHaveBeenCalledWith(TICKET, {
        userId: TEAMMATE,
        reason: 'Going off shift',
      });
    });

    it('refuses a caller holding neither ticket:handoff nor ticket:assign', async () => {
      // Nothing in `ROLE_PERMISSIONS` is such a caller today — every role holds
      // `ticket:handoff` — so this asserts the guard rather than a role, which
      // is what keeps the route from becoming public if the matrix changes.
      principal = principalWith(
        permissionsForRole('agent').filter((permission) => permission !== 'ticket:handoff'),
      );

      await request(server).post(path).send({ userId: TEAMMATE }).expect(403);
      expect(assign).not.toHaveBeenCalled();
    });

    it('refuses an unauthenticated caller before reaching the service', async () => {
      signedIn = false;

      const response = await request(server).post(path).send({ userId: TEAMMATE }).expect(401);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
      expect(assign).not.toHaveBeenCalled();
    });

    it('refuses an id that is not a UUID', async () => {
      const response = await request(server)
        .post('/api/v1/tickets/not-a-uuid/assign')
        .send({ userId: TEAMMATE })
        .expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(assign).not.toHaveBeenCalled();
    });

    it('refuses a body naming neither a user nor a team', async () => {
      const response = await request(server).post(path).send({}).expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(assign).not.toHaveBeenCalled();
    });

    it('answers 200 with the assigned ticket, in the published shape', async () => {
      // 200 and not 201: nothing was created, and the body is the ticket as it
      // now stands — the shape the console puts straight back in its cache.
      assign.mockResolvedValue({
        ...TICKET_RESPONSE,
        assignedUserId: TEAMMATE,
        routing: { state: 'manual', deferredReason: null, deferredSince: null },
      });

      const response = await request(server).post(path).send({ userId: TEAMMATE }).expect(200);
      const ticket = TicketResponseSchema.parse(response.body);

      expect(ticket.assignedUserId).toBe(TEAMMATE);
      expect(ticket.routing.state).toBe('manual');
      expect(assign).toHaveBeenCalledWith(TICKET, { userId: TEAMMATE });
    });

    it('passes an explicit null through rather than dropping it', async () => {
      // `{ userId: null }` is a release, not an absent field, and a pipe that
      // stripped it would turn the one into the other.
      assign.mockResolvedValue(TICKET_RESPONSE);

      await request(server).post(path).send({ userId: null, reason: 'Parked' }).expect(200);

      expect(assign).toHaveBeenCalledWith(TICKET, { userId: null, reason: 'Parked' });
    });

    it('maps an assignee this tenant does not have to validation_failed, naming the field', async () => {
      // Not `not_found`: the ticket was found, and a 404 here would read as "the
      // ticket is gone" — the wrong recovery for a stale name in a dropdown.
      assign.mockRejectedValue(new UnknownTicketAssigneeError('userId', 'user', TEAMMATE));

      const response = await request(server).post(path).send({ userId: TEAMMATE }).expect(400);
      const { error } = ApiErrorSchema.parse(response.body);

      expect(error.code).toBe('validation_failed');
      expect(error.details).toEqual([{ path: 'userId', message: expect.any(String) as string }]);
    });

    it('answers not_found for a ticket this principal may not see', async () => {
      assign.mockRejectedValue(new TicketNotFoundError(TICKET));

      const response = await request(server).post(path).send({ userId: TEAMMATE }).expect(404);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
    });

    it('maps a refused handoff to forbidden, not not_found', async () => {
      // The caller passed the visibility check and is looking at the ticket, so
      // what is refused is the act (0011 decision 2).
      assign.mockRejectedValue(TicketHandoffNotPermittedError.notHeld());

      const response = await request(server).post(path).send({ userId: TEAMMATE }).expect(403);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('forbidden');
    });

    it('maps a missing reason to validation_failed, pointing at the field', async () => {
      assign.mockRejectedValue(new TicketReasonRequiredError());

      const response = await request(server).post(path).send({ userId: TEAMMATE }).expect(400);
      const { error } = ApiErrorSchema.parse(response.body);

      expect(error.code).toBe('validation_failed');
      expect(error.details).toEqual([{ path: 'reason', message: expect.any(String) as string }]);
    });

    it('refuses a blank reason at the schema, before the service', async () => {
      // The trim and the three-character floor: whitespace is not a reason, and
      // the empty string would otherwise satisfy "present" and log nothing.
      const response = await request(server)
        .post(path)
        .send({ userId: TEAMMATE, reason: '   ' })
        .expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/tickets/{id}/escalate', () => {
    const path = `/api/v1/tickets/${TICKET}/escalate`;
    const ESCALATION = {
      event: {
        id: '25444444-4444-7444-8444-4444444444a1',
        ticketId: TICKET,
        type: 'escalated' as const,
        actorUserId: AGENT.userId,
        fromValue: null,
        toValue: null,
        assignment: null,
        reason: 'Customer is threatening chargeback',
        cause: 'agent' as const,
        createdAt: '2026-08-16T10:00:00.000Z',
      },
      notifiedUserIds: ['25444444-4444-7444-8444-4444444444d4'],
    };

    it('admits an agent: ticket:escalate is granted to every role', async () => {
      escalate.mockResolvedValue(ESCALATION);

      const response = await request(server)
        .post(path)
        .send({ reason: 'Customer is threatening chargeback' })
        .expect(200);

      expect(TicketEscalationResponseSchema.parse(response.body).notifiedUserIds).toHaveLength(1);
      expect(escalate).toHaveBeenCalledWith(TICKET, {
        reason: 'Customer is threatening chargeback',
      });
    });

    it('refuses a caller without ticket:escalate', async () => {
      principal = principalWith(
        permissionsForRole('agent').filter((permission) => permission !== 'ticket:escalate'),
      );

      await request(server).post(path).send({ reason: 'Please look at this' }).expect(403);
      expect(escalate).not.toHaveBeenCalled();
    });

    it('refuses a body with no reason', async () => {
      // Unconditionally required here: there is no escalation without something
      // to escalate, so the reason is the whole payload (0011 decision 3).
      const response = await request(server).post(path).send({}).expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(escalate).not.toHaveBeenCalled();
    });

    it('refuses a whitespace-only reason', async () => {
      await request(server).post(path).send({ reason: '   ' }).expect(400);
      expect(escalate).not.toHaveBeenCalled();
    });

    it('answers 200 with an empty notifiedUserIds when nobody could be told', async () => {
      // A real outcome, not an error: the agent did nothing wrong and has no way
      // to fix a tenant with no active supervisor.
      escalate.mockResolvedValue({ ...ESCALATION, notifiedUserIds: [] });

      const response = await request(server)
        .post(path)
        .send({ reason: 'Nobody is on call tonight' })
        .expect(200);

      expect(TicketEscalationResponseSchema.parse(response.body).notifiedUserIds).toEqual([]);
    });

    it('does not reach the idempotency middleware without a key', async () => {
      escalate.mockResolvedValue(ESCALATION);

      await request(server).post(path).send({ reason: 'A second ask is legitimate' }).expect(200);

      expect(execute).not.toHaveBeenCalled();
      expect(escalate).toHaveBeenCalled();
    });

    it('runs through the idempotency middleware when a key is sent', async () => {
      escalate.mockResolvedValue(ESCALATION);

      await request(server)
        .post(path)
        .set('Idempotency-Key', '25444444-4444-7444-8444-4444444444ff')
        .send({ reason: 'Retried after a dropped response' })
        .expect(200);

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          key: '25444444-4444-7444-8444-4444444444ff',
          operation: 'ticket.escalate',
          target: TICKET,
        }),
        expect.any(Function),
      );
    });

    it('refuses a malformed key rather than ignoring it', async () => {
      // Accepting it would silently drop the protection the caller asked for.
      const response = await request(server)
        .post(path)
        .set('Idempotency-Key', 'not-a-uuid')
        .send({ reason: 'Please look at this' })
        .expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(escalate).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/tickets/{id}/events', () => {
    const path = `/api/v1/tickets/${TICKET}/events`;

    it('needs only ticket:read, and binds the cursor page defaults', async () => {
      listEvents.mockResolvedValue({ items: [], nextCursor: null });

      await request(server).get(path).expect(200);

      expect(listEvents).toHaveBeenCalledWith(TICKET, { limit: 25 });
    });

    it('answers not_found for a ticket this principal may not see', async () => {
      // The log inherits the ticket's visibility rule rather than becoming a
      // side channel onto one — 404, never 403.
      listEvents.mockRejectedValue(new TicketNotFoundError(TICKET));

      const response = await request(server).get(path).expect(404);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
    });

    it('refuses an id that is not a UUID', async () => {
      await request(server).get('/api/v1/tickets/not-a-uuid/events').expect(400);
      expect(listEvents).not.toHaveBeenCalled();
    });

    it('refuses an unauthenticated caller before reaching the service', async () => {
      signedIn = false;

      await request(server).get(path).expect(401);
      expect(listEvents).not.toHaveBeenCalled();
    });
  });
});
