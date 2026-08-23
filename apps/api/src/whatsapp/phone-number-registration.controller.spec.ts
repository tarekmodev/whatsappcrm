import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  WhatsAppPhoneNumberRegistrationResponseSchema,
  permissionsForRole,
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
import { WhatsAppPhoneNumberRegistrationController } from './phone-number-registration.controller';
import {
  WhatsAppPhoneNumberRegistrationService,
  type NumberRegistrationState,
} from './phone-number-registration.service';
import {
  WhatsAppAccountNotFoundError,
  WhatsAppCredentialMissingError,
  WhatsAppTokenUndecryptableError,
} from './whatsapp.errors';

/**
 * The HTTP contract of
 * `POST /api/v1/whatsapp/phone-numbers/{whatsappAccountId}/registration`.
 *
 * The assertion that carries the story is the one about status codes: a
 * registration Meta refused answers **200** with a reason in the body, not a 4xx.
 * The first attempt runs inside a successful connection and cannot report its
 * failure as an error envelope, so a retry that used one would make the console
 * parse the same fact two different ways. Everything else here is the ordinary
 * pipeline — proved with the real `PrincipalGuard` and `PermissionGuard`, so
 * what is under test is the shipped refusal rather than a check this controller
 * remembered.
 */

const TENANT_ID = '50444444-4444-7444-8444-4444444444c1';
const ACCOUNT_ID = '70444444-4444-7444-8444-444444444401';
const PHONE_NUMBER_ID = '15550001111';
const REGISTERED_AT = new Date('2026-08-23T09:00:00.000Z');

const REGISTERED: NumberRegistrationState = {
  whatsappAccountId: ACCOUNT_ID,
  phoneNumberId: PHONE_NUMBER_ID,
  registrationStatus: 'registered',
  registrationFailureReason: null,
  registeredAt: REGISTERED_AT,
  registrationAttemptedAt: REGISTERED_AT,
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

describe('POST /api/v1/whatsapp/phone-numbers/{whatsappAccountId}/registration', () => {
  let app: INestApplication;
  let server: Server;
  let register: jest.Mock;
  let principal: SessionPrincipal | null;

  beforeAll(async () => {
    register = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [WhatsAppPhoneNumberRegistrationController],
      providers: [
        ApiExceptionFilter,
        { provide: WhatsAppPhoneNumberRegistrationService, useValue: { register } },
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
    register.mockReset().mockResolvedValue(REGISTERED);
  });

  function post(whatsappAccountId: string = ACCOUNT_ID) {
    return request(server).post(`/api/v1/whatsapp/phone-numbers/${whatsappAccountId}/registration`);
  }

  it('refuses a request with no session, without touching the registration service', async () => {
    principal = null;

    const response = await post();

    expect(response.status).toBe(401);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
    expect(register).not.toHaveBeenCalled();
  });

  it('refuses a signed-in caller without channel:manage, before the handler runs', async () => {
    // An agent may send on a connected number and may not set one up. Same
    // permission as connecting, because this finishes what connecting started.
    principal = principalWith('agent');

    const response = await post();

    expect(response.status).toBe(403);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('forbidden');
    expect(register).not.toHaveBeenCalled();
  });

  it('answers 200 with the published shape and marks the attempt a retry', async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(WhatsAppPhoneNumberRegistrationResponseSchema.parse(response.body)).toEqual({
      whatsappAccountId: ACCOUNT_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      registrationStatus: 'registered',
      registrationFailureReason: null,
      registeredAt: REGISTERED_AT.toISOString(),
      registrationAttemptedAt: REGISTERED_AT.toISOString(),
    });
    expect(register).toHaveBeenCalledWith({
      whatsappAccountId: ACCOUNT_ID,
      attempt: 'retry',
    });
  });

  it.each([
    ['a refusal this build does not model', 'rejected' as const],
    ['throttling', 'rate_limited' as const],
    ['an outage', 'upstream_unavailable' as const],
    ['a rejected credential', 'credential_rejected' as const],
  ])('answers 200 with a reason for %s rather than an error envelope', async (_case, reason) => {
    // `rate_limited` and `upstream_unavailable` appear here as reasons in a 200
    // body rather than as the platform error codes of the same name. A
    // deliberate departure, and confined to this field: the call did what it was
    // asked, and the first attempt reports the identical fact the identical way.
    register.mockResolvedValue({
      ...REGISTERED,
      registrationStatus: 'failed',
      registrationFailureReason: reason,
      registeredAt: null,
    });

    const response = await post();

    expect(response.status).toBe(200);
    expect(WhatsAppPhoneNumberRegistrationResponseSchema.parse(response.body)).toMatchObject({
      registrationStatus: 'failed',
      registrationFailureReason: reason,
    });
  });

  it('reports a number that is already registered as the no-op it is', async () => {
    const response = await post();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ registrationStatus: 'registered' });
  });

  it.each([
    ['a number that names nothing reachable', new WhatsAppAccountNotFoundError(ACCOUNT_ID)],
    ['a WABA with no stored credential', new WhatsAppCredentialMissingError('102290129340398')],
  ])('answers not_found for %s', async (_case, thrown) => {
    // Another tenant's id has to be absent rather than forbidden: a 403 would
    // confirm the id exists (TAR-39, security).
    register.mockRejectedValue(thrown);

    const response = await post();

    expect(response.status).toBe(404);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
  });

  it('refuses an id that is not one of ours before the service is reached', async () => {
    const response = await post('not-a-uuid');

    expect(response.status).toBe(400);
    expect(register).not.toHaveBeenCalled();
  });

  it('answers subscription_inactive for a session outliving its tenant', async () => {
    register.mockRejectedValue(new TenantNotActiveError(TENANT_ID, '$tenantTransaction'));

    const response = await post();

    expect(response.status).toBe(402);

    const body = ApiErrorSchema.parse(response.body);

    // The shared helper, so this route and every other say the same thing about
    // the same condition (TAR-539).
    expect(body.error.code).toBe('subscription_inactive');
    // The error names the data layer and the tenant id; neither belongs in a
    // response body (TAR-539).
    expect(body.error.message).not.toContain(TENANT_ID);
  });

  it('leaves a key-and-ciphertext mismatch as a fault, because it is our deployment', async () => {
    register.mockRejectedValue(new WhatsAppTokenUndecryptableError('102290129340398'));

    const response = await post();

    expect(response.status).toBe(500);
  });
});
