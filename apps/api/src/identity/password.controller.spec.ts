import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ApiErrorSchema } from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { HostTenantGuard } from '../tenancy/host-tenant.guard';
import { ResetTokenInvalidError, CurrentPasswordIncorrectError } from './identity.errors';
import { PasswordChangeService } from './password-change.service';
import { PasswordController } from './password.controller';
import { PasswordResetService } from './password-reset.service';

/**
 * The HTTP contract of TAR-53's three password routes.
 *
 * The guards are stubbed to pass, deliberately: what this file is for is the
 * *shape* of the answers — the unconditional 204 that makes the reset endpoint
 * useless as an enumeration oracle, and the 410 that lets the reset screen offer
 * a new link. Which callers get past the guards is `PermissionGuard`'s and
 * `PrincipalGuard`'s own coverage, and cross-tenant isolation is proved against
 * real Postgres in `password-reset-isolation.int-spec.ts`.
 */

const VALID_PASSWORD = 'a perfectly long passphrase';

describe('password routes', () => {
  let app: INestApplication;
  let server: Server;
  let requestReset: jest.Mock;
  let confirmReset: jest.Mock;
  let change: jest.Mock;

  beforeAll(async () => {
    requestReset = jest.fn();
    confirmReset = jest.fn();
    change = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [PasswordController],
      providers: [
        ApiExceptionFilter,
        {
          provide: PasswordResetService,
          useValue: { request: requestReset, confirm: confirmReset },
        },
        { provide: PasswordChangeService, useValue: { change } },
        // `configureApp` reads `WEB_ORIGIN` for the CORS allow-list. Supplied
        // here so this spec configures the app exactly as the deployed one is,
        // without importing the whole `ConfigModule`.
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    })
      .overrideGuard(HostTenantGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PrincipalGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();

    const middleware = app.get(TenantContextMiddleware);
    app.use(middleware.use.bind(middleware));

    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    requestReset.mockReset().mockResolvedValue(undefined);
    confirmReset.mockReset().mockResolvedValue(undefined);
    change.mockReset().mockResolvedValue(undefined);
  });

  describe('POST /api/v1/auth/password-reset', () => {
    function post(body: object) {
      return request(server).post('/api/v1/auth/password-reset').send(body);
    }

    it('answers 204 with an empty body', async () => {
      const response = await post({ email: 'agent@example.invalid' });

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
    });

    it('answers 204 identically for an address the service found nothing for', async () => {
      // The service resolves either way; nothing about the outcome reaches the
      // caller, which is what stops this endpoint answering "does this person
      // work here".
      const known = await post({ email: 'agent@example.invalid' });
      const unknown = await post({ email: 'nobody@example.invalid' });

      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
    });

    it('rejects a body that is not an email address', async () => {
      const response = await post({ email: 'not-an-address' });

      expect(response.status).toBe(400);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(requestReset).not.toHaveBeenCalled();
    });

    it('passes the caller address through for forensics', async () => {
      await post({ email: 'agent@example.invalid' });

      expect(requestReset).toHaveBeenCalledWith(
        { email: 'agent@example.invalid' },
        expect.stringMatching(/\d|:/),
      );
    });
  });

  describe('POST /api/v1/auth/password-reset/confirm', () => {
    function post(body: object) {
      return request(server).post('/api/v1/auth/password-reset/confirm').send(body);
    }

    it('answers 204 on success and issues no session', async () => {
      const response = await post({ token: 'tok3n', password: VALID_PASSWORD });

      expect(response.status).toBe(204);
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('answers 410 token_invalid for a spent link, with the reason', async () => {
      confirmReset.mockRejectedValue(new ResetTokenInvalidError('consumed'));

      const response = await post({ token: 'tok3n', password: VALID_PASSWORD });

      expect(response.status).toBe(410);
      const { error } = ApiErrorSchema.parse(response.body);
      expect(error.code).toBe('token_invalid');
      expect(error.details).toEqual([{ path: 'token', message: 'consumed' }]);
    });

    it('enforces the published minimum password length before reaching the service', async () => {
      const response = await post({ token: 'tok3n', password: 'short' });

      expect(response.status).toBe(400);
      expect(confirmReset).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/auth/password', () => {
    function post(body: object) {
      return request(server).post('/api/v1/auth/password').send(body);
    }

    it('answers 204 on success', async () => {
      const response = await post({
        currentPassword: 'the current one',
        newPassword: VALID_PASSWORD,
      });

      expect(response.status).toBe(204);
      expect(change).toHaveBeenCalledWith({
        currentPassword: 'the current one',
        newPassword: VALID_PASSWORD,
      });
    });

    it('answers 401 invalid_credentials when the current password is wrong', async () => {
      change.mockRejectedValue(new CurrentPasswordIncorrectError());

      const response = await post({ currentPassword: 'wrong', newPassword: VALID_PASSWORD });

      expect(response.status).toBe(401);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('invalid_credentials');
    });

    it('requires the current password, whatever the session says', async () => {
      const response = await post({ newPassword: VALID_PASSWORD });

      expect(response.status).toBe(400);
      expect(change).not.toHaveBeenCalled();
    });

    it('strips unknown fields rather than trusting them', async () => {
      await post({
        currentPassword: 'the current one',
        newPassword: VALID_PASSWORD,
        userId: '00000000-0000-7000-8000-000000000001',
      });

      // There is no user id anywhere in this flow. If one ever reaches the
      // service, somebody has added a way to change somebody else's password.
      expect(change).toHaveBeenCalledWith({
        currentPassword: 'the current one',
        newPassword: VALID_PASSWORD,
      });
    });
  });
});
