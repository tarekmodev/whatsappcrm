import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  ConnectedWhatsAppBusinessAccountResponseSchema,
  permissionsForRole,
  whatsAppSignupFailureReason,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { ANONYMOUS, PRINCIPAL_SOURCE, resolved } from '../rbac/principal.source';
import type { ConnectBusinessAccountResult } from './business-account-connection.service';
import { WhatsAppBusinessAccountsController } from './business-accounts.controller';
import { WhatsAppEmbeddedSignupService } from './embedded-signup.service';
import { MetaRateLimitedError, MetaUnavailableError } from './meta-cloud-api.errors';
import {
  WhatsAppEncryptionUnavailableError,
  WhatsAppIdentityTakenError,
  WhatsAppSignupFailedError,
} from './whatsapp.errors';

/**
 * The HTTP contract of `POST /api/v1/whatsapp/business-accounts`.
 *
 * Two assertions carry the story. The first is that a caller without
 * `channel:manage` is refused by the pipeline before the handler runs — proved
 * with the **real** `PrincipalGuard` and `PermissionGuard`, registered as
 * `APP_GUARD` the way `RequestPipelineModule` registers them, so what is under
 * test is the shipped refusal rather than a check this controller remembered.
 * The second is that every failure carries a `details.reason` the console can
 * branch on, because "try again" pointed at the wrong thing is worse than
 * nothing when the credential being retried is spent either way.
 *
 * `HostTenantGuard` needs a database, so the middleware below stands in for it.
 */

const TENANT_ID = '50444444-4444-7444-8444-4444444444c1';
const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';
const WABA_ID = '102290129340398';
const CODE = 'AQD-an-exchangeable-token-code';
const TIMESTAMP = new Date('2026-08-10T09:00:00.000Z');

const SIGNUP_BODY = { code: CODE, wabaId: WABA_ID, phoneNumberId: '15550001111' };

const CONNECTED: ConnectBusinessAccountResult = {
  created: true,
  businessAccount: {
    id: WABA_ROW_ID,
    wabaId: WABA_ID,
    name: "Jasper's Market",
    verificationStatus: 'verified',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    accounts: [
      {
        id: '70444444-4444-7444-8444-444444444401',
        whatsappBusinessAccountId: WABA_ROW_ID,
        phoneNumberId: '15550001111',
        displayPhoneNumber: '+15550001111',
        verifiedName: "Jasper's Market",
        qualityRating: 'green',
        status: 'connected',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
  },
};

function principalWith(role: SessionPrincipal['role']): SessionPrincipal {
  return {
    userId: '50444444-4444-7444-8444-4444444444a1',
    tenantId: TENANT_ID,
    email: 'admin@example.invalid',
    displayName: 'Ada Admin',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: '50444444-4444-7444-8444-4444444444f1',
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

describe('POST /api/v1/whatsapp/business-accounts', () => {
  let app: INestApplication;
  let server: Server;
  let connect: jest.Mock;
  let principal: SessionPrincipal | null;

  beforeAll(async () => {
    connect = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [WhatsAppBusinessAccountsController],
      providers: [
        ApiExceptionFilter,
        { provide: WhatsAppEmbeddedSignupService, useValue: { connect } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PRINCIPAL_SOURCE,
          useValue: {
            resolve: () => Promise.resolve(principal === null ? ANONYMOUS : resolved(principal)),
          },
        },
        { provide: APP_GUARD, useClass: PrincipalGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    const middleware = app.get(TenantContextMiddleware);
    const tenantContext = app.get(TenantContextService);

    app.use(middleware.use.bind(middleware));
    // Stands in for `HostTenantGuard`, which needs a database.
    app.use((_request: unknown, _response: unknown, next: () => void) => {
      tenantContext.setTenant(TENANT_ID);
      next();
    });

    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    principal = principalWith('admin');
    connect.mockReset().mockResolvedValue(CONNECTED);
  });

  function post(body: object = SIGNUP_BODY) {
    return request(server).post('/api/v1/whatsapp/business-accounts').send(body);
  }

  it('refuses a request with no session, without reaching Meta', async () => {
    principal = null;

    const response = await post();

    expect(response.status).toBe(401);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a signed-in caller without channel:manage, before the handler runs', async () => {
    // An agent may send on a connected number and may not connect one. The
    // refusal comes from the pipeline, which is what makes it true of every
    // route rather than of the ones that remembered.
    principal = principalWith('agent');

    const response = await post();

    expect(response.status).toBe(403);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('forbidden');
    expect(connect).not.toHaveBeenCalled();
  });

  it('answers 201 with the published shape when it connected the account', async () => {
    const response = await post();

    expect(response.status).toBe(201);
    expect(ConnectedWhatsAppBusinessAccountResponseSchema.parse(response.body)).toMatchObject({
      wabaId: WABA_ID,
      accounts: [{ phoneNumberId: '15550001111', displayPhoneNumber: '+15550001111' }],
    });
  });

  it('answers 200 when the WABA was already connected and this updated it', async () => {
    connect.mockResolvedValue({ ...CONNECTED, created: false });

    await expect(post()).resolves.toMatchObject({ status: 200 });
  });

  it('passes only the code and the claimed WABA on; the numbers come from Meta', async () => {
    await post();

    expect(connect).toHaveBeenCalledWith({ code: CODE, wabaId: WABA_ID });
  });

  it('never echoes the code back', async () => {
    const response = await post();

    expect(JSON.stringify(response.body)).not.toContain(CODE);
  });

  it.each([
    ['no code', { wabaId: WABA_ID }],
    ['an empty code', { code: '', wabaId: WABA_ID }],
    ['no WABA id', { code: CODE }],
    ['a WABA id that is not a Meta id', { code: CODE, wabaId: 'not-an-id' }],
    ['a phone number id that is not a Meta id', { ...SIGNUP_BODY, phoneNumberId: 'nope' }],
  ])('rejects a body with %s', async (_case, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
    expect(connect).not.toHaveBeenCalled();
  });

  it('drops a pasted access token instead of honouring one on a tenant-facing route', async () => {
    // The browser never holds a WABA token — that is the whole reason Embedded
    // Signup returns a code. The schema strips it, so nothing downstream is one
    // forgotten check away from accepting a credential from a client.
    await post({ ...SIGNUP_BODY, accessToken: 'EAAG-pasted-by-hand' });

    expect(connect).toHaveBeenCalledWith({ code: CODE, wabaId: WABA_ID });
  });

  it.each(['code_expired', 'code_invalid', 'insufficient_permissions', 'waba_mismatch'] as const)(
    'reports a %s failure with the reason the console branches on',
    async (reason) => {
      connect.mockRejectedValue(new WhatsAppSignupFailedError(reason, 'Start it again.'));

      const response = await post();

      expect(response.status).toBe(400);

      const error = ApiErrorSchema.parse(response.body);

      expect(error.error.code).toBe('whatsapp_signup_failed');
      expect(whatsAppSignupFailureReason(error)).toBe(reason);
    },
  );

  it('reports a signup failure outside the published vocabulary without inventing a reason', async () => {
    connect.mockRejectedValue(
      new WhatsAppSignupFailedError(null, 'This WABA has no phone number.'),
    );

    const response = await post();
    const error = ApiErrorSchema.parse(response.body);

    expect(error.error.code).toBe('whatsapp_signup_failed');
    expect(error.error.message).toContain('no phone number');
    expect(whatsAppSignupFailureReason(error)).toBeNull();
  });

  it('answers 409 when another tenant already holds the WABA', async () => {
    connect.mockRejectedValue(new WhatsAppIdentityTakenError('waba', WABA_ID));

    const response = await post();

    expect(response.status).toBe(409);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('conflict');
  });

  it('reports Meta throttling as rate limited, so it reads as "later" rather than "no"', async () => {
    connect.mockRejectedValue(new MetaRateLimitedError(429, null, 30));

    const response = await post();

    expect(response.status).toBe(429);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('rate_limited');
  });

  it('reports a Meta outage as an upstream failure', async () => {
    connect.mockRejectedValue(new MetaUnavailableError(503, null, 'HTTP 503'));

    const response = await post();

    expect(response.status).toBe(502);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('upstream_unavailable');
  });

  it('refuses to connect a channel to a tenant that has been deactivated', async () => {
    connect.mockRejectedValue(
      new TenantNotActiveError(TENANT_ID, 'create', 'WhatsappBusinessAccount'),
    );

    const response = await post();

    expect(response.status).toBe(402);
    const { error } = ApiErrorSchema.parse(response.body);

    expect(error.code).toBe('subscription_inactive');
    // TAR-539: the error's own message names `TenantPrisma` and the tenant id.
    expect(error.message).not.toContain('TenantPrisma');
    expect(error.message).not.toContain(TENANT_ID);
  });

  it('reports our own key misconfiguration as a fault, not as the tenant’s mistake', async () => {
    // No encryption key in this environment. Telling the tenant to re-run the
    // flow would send them round a 30-second window for a deployment gap.
    connect.mockRejectedValue(new WhatsAppEncryptionUnavailableError());

    await expect(post()).resolves.toMatchObject({ status: 500 });
  });
});
