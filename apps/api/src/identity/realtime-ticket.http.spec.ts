import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  RealtimeTicketResponseSchema,
  permissionsForRole,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { REQUIRED_PERMISSIONS } from '../rbac/require-permission.decorator';
import { AuthService } from './auth.service';
import { RealtimeTicketUnavailableError } from './identity.errors';
import { RealtimeTicketService } from './realtime-ticket.service';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';

/**
 * The HTTP contract of `POST /api/v1/auth/realtime-ticket` (TAR-180).
 *
 * No guard runs, deliberately, on `password.controller.spec`'s reasoning: since
 * TAR-58 the pipeline is installed by `RequestPipelineModule`, which this narrow
 * testing module does not import. That a caller with no session is refused
 * follows from the posture the route declares — `@AnyPrincipal()`, asserted
 * below and enforced globally by `PermissionGuard`, with the 401 itself proved
 * against the real guards in `request-pipeline.http.spec`. That every route
 * declares exactly one posture is `route-posture.spec`.
 *
 * What is under test here is the answer: that it matches the published schema,
 * that it takes nothing from the caller, and that the credential in the body
 * cannot be cached on the way back.
 */

const TENANT_ID = '80222222-2222-7222-8222-222222222201';

const PRINCIPAL: SessionPrincipal = {
  userId: '80222222-2222-7222-8222-2222222222a1',
  tenantId: TENANT_ID,
  email: 'ada@acme.invalid',
  displayName: 'Ada Agent',
  role: 'agent',
  permissions: [...permissionsForRole('agent')],
  teamIds: [],
  sessionId: '80222222-2222-7222-8222-2222222222f1',
  expiresAt: '2036-12-31T23:59:59.000Z',
};

const TICKET = {
  ticket: 'dGhpcy1pcy10aGUtdGlja2V0LWFuZC1uZXZlci1hLWNvb2tpZQ',
  expiresAt: '2036-12-31T23:59:59.000Z',
  realtimeUrl: 'https://realtime.example.invalid',
};

describe('POST /api/v1/auth/realtime-ticket', () => {
  let app: INestApplication;
  let server: Server;
  let issue: jest.Mock;

  beforeAll(async () => {
    issue = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [SessionController],
      providers: [
        ApiExceptionFilter,
        { provide: RealtimeTicketService, useValue: { issue, consume: jest.fn() } },
        // The other two collaborators the controller's own routes need. Nothing
        // in this file calls them, and a mock that answers nothing is the honest
        // shape for that.
        { provide: AuthService, useValue: { logout: jest.fn() } },
        { provide: SessionService, useValue: { listOwn: jest.fn(), revokeOwn: jest.fn() } },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    jest
      .spyOn(TenantContextService.prototype, 'requirePrincipal')
      .mockImplementation(() => PRINCIPAL);

    app = moduleRef.createNestApplication();

    const middleware = app.get(TenantContextMiddleware);
    app.use(middleware.use.bind(middleware));

    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  beforeEach(() => {
    issue.mockReset().mockResolvedValue(TICKET);
  });

  function post(body: object = {}) {
    return request(server).post('/api/v1/auth/realtime-ticket').send(body);
  }

  it('answers 200 with a body the published schema accepts', async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(RealtimeTicketResponseSchema.parse(response.body)).toEqual(TICKET);
  });

  it('issues for the resolved principal and for nothing the caller sent', async () => {
    // A body naming another tenant, another user and another role. The handler
    // takes no body at all, so none of it can reach the service — the ticket is
    // a function of the session and of nothing else.
    await post({
      tenantId: '80222222-2222-7222-8222-2222222222ff',
      userId: '80222222-2222-7222-8222-2222222222fe',
      role: 'admin',
    });

    expect(issue).toHaveBeenCalledTimes(1);
    expect(issue).toHaveBeenCalledWith(PRINCIPAL);
  });

  it('forbids a cache from keeping the credential it just returned', async () => {
    const response = await post();

    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('answers 502 upstream_unavailable when no ticket could be stored', async () => {
    issue.mockRejectedValue(new RealtimeTicketUnavailableError());

    const response = await post();

    // Not a 4xx: the session is valid and the request was correct. A console
    // told otherwise would send the agent off re-authenticating against a
    // problem authentication cannot fix.
    expect(response.status).toBe(502);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('upstream_unavailable');
  });

  it('declares the posture that makes an unauthenticated caller a 401', () => {
    // `@AnyPrincipal()` — signed in, and no permission beyond that, because the
    // resource is the caller. `PermissionGuard` refuses a route whose metadata
    // is absent and `PrincipalGuard` refuses one with no session, so this empty
    // array is what stands between the route and both refusals. Asserted here
    // because the guards do not run in this module.
    //
    // Read off the descriptor rather than off the prototype, the way
    // `route-posture.spec` reads it: touching the method as a value is what the
    // unbound-method rule exists to catch, and the metadata is on the function
    // either way.
    const handler: unknown = Object.getOwnPropertyDescriptor(
      SessionController.prototype,
      'issueRealtimeTicket',
    )?.value;

    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler as object)).toEqual([]);
  });

  it('is not reachable with a GET', async () => {
    // The verb is part of the contract (ADR 0002, ADR 0005): every call mints
    // and stores a new credential, which is not something a safe method may do
    // or an intermediary may replay.
    const response = await request(server).get('/api/v1/auth/realtime-ticket');

    expect(response.status).toBe(404);
    expect(issue).not.toHaveBeenCalled();
  });
});
