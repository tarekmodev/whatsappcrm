import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  SESSION_COOKIE_NAME,
  SessionListResponseSchema,
  SessionResponseSchema,
  permissionsForRole,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiException } from '../common/errors/api.exception';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { HostTenantGuard } from '../tenancy/host-tenant.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import {
  AccountLockedError,
  InvalidCredentialsError,
  SessionNotFoundError,
} from './identity.errors';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';

/**
 * The HTTP contract of the five auth routes.
 *
 * The assertions that matter most are about the `Set-Cookie` header and about
 * what the *body* does not contain: the session token leaves in one header and
 * exists nowhere else in the response, which is what makes it unreadable to
 * script on the page.
 *
 * The guards are replaced rather than exercised — `HostTenantGuard` needs a
 * database and `PrincipalGuard` needs a session, and both have their own specs.
 * What is under test here is that they are *declared*: the unauthenticated
 * cases below fail before any service is called.
 */

const TENANT = '56666666-6666-7666-8666-666666666601';
const USER = '56666666-6666-7666-8666-6666666666a1';
const SESSION = '56666666-6666-7666-8666-6666666666b1';

const CREDENTIALS = { email: 'agent@acme.invalid', password: 'correct horse battery staple' };

const PRINCIPAL: SessionPrincipal = {
  userId: USER,
  tenantId: TENANT,
  email: CREDENTIALS.email,
  displayName: 'Ada',
  role: 'agent',
  permissions: [...permissionsForRole('agent')],
  teamIds: [],
  sessionId: SESSION,
  expiresAt: '2026-08-12T09:00:00.000Z',
};

describe('auth routes', () => {
  let app: INestApplication;
  let server: Server;
  let login: jest.Mock;
  let logout: jest.Mock;
  let listOwn: jest.Mock;
  let revokeOwn: jest.Mock;
  let signedIn: boolean;

  beforeAll(async () => {
    login = jest.fn();
    logout = jest.fn();
    listOwn = jest.fn();
    revokeOwn = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [AuthController, SessionController],
      providers: [
        ApiExceptionFilter,
        { provide: AuthService, useValue: { login, logout } },
        { provide: SessionService, useValue: { listOwn, revokeOwn } },
        // `SESSION_COOKIE_SECURE=false`, so the assertions below read the
        // development spelling. `configureApp` also reads `WEB_ORIGIN`.
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'SESSION_COOKIE_SECURE' ? false : undefined) },
        },
      ],
    })
      .overrideGuard(HostTenantGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PrincipalGuard)
      .useValue({
        // Refuses the way the real guard does — `unauthenticated`, not Nest's
        // default 403 — so the assertions below are about what a client sees
        // rather than about how this stub happens to say no.
        canActivate: () => {
          if (!signedIn) {
            throw new ApiException('unauthenticated', 'This request requires a signed-in user.');
          }

          return true;
        },
      })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();

    const middleware = app.get(TenantContextMiddleware);

    app.use(middleware.use.bind(middleware));
    // The principal the replaced `PrincipalGuard` would have published. Set on
    // the scope the middleware opened, which is where the controllers read it.
    app.use((_request: unknown, _response: unknown, next: () => void) => {
      if (signedIn) {
        app.get(TenantContextService).setPrincipal(PRINCIPAL);
      }

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
    signedIn = true;
    login.mockReset().mockResolvedValue({
      principal: PRINCIPAL,
      issued: {
        token: 'plaintext-token',
        tokenHash: 'hash',
        sessionId: SESSION,
        expiresAt: new Date(),
      },
    });
    logout.mockReset().mockResolvedValue(undefined);
    listOwn.mockReset().mockResolvedValue([]);
    revokeOwn.mockReset().mockResolvedValue(undefined);
  });

  describe('POST /api/v1/auth/login', () => {
    it('answers the principal and sets the session cookie', async () => {
      const response = await request(server).post('/api/v1/auth/login').send(CREDENTIALS);

      expect(response.status).toBe(200);
      expect(SessionResponseSchema.parse(response.body).user).toEqual(PRINCIPAL);
    });

    it('puts the token in a hardened cookie and in nothing else', async () => {
      const response = await request(server).post('/api/v1/auth/login').send(CREDENTIALS);

      const cookie = (response.headers['set-cookie'] as unknown as string[])[0] ?? '';

      expect(cookie).toContain(`${SESSION_COOKIE_NAME}=plaintext-token`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
      // No `Domain`, or the cookie reaches every tenant's subdomain.
      expect(cookie).not.toContain('Domain');
      // The credential exists in that header and nowhere else in the response.
      expect(JSON.stringify(response.body)).not.toContain('plaintext-token');
    });

    it('answers invalid_credentials without saying which half was wrong', async () => {
      login.mockRejectedValue(new InvalidCredentialsError());

      const response = await request(server).post('/api/v1/auth/login').send(CREDENTIALS);

      expect(response.status).toBe(401);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('invalid_credentials');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('answers 429 with Retry-After for a locked account', async () => {
      login.mockRejectedValue(new AccountLockedError(812));

      const response = await request(server).post('/api/v1/auth/login').send(CREDENTIALS);

      expect(response.status).toBe(429);
      // `rate_limited` rather than a code of its own: a distinct code would
      // confirm the address belongs to a real account.
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('rate_limited');
      expect(response.headers['retry-after']).toBe('812');
    });

    it('rejects a malformed body before reaching the service', async () => {
      const response = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-address', password: '' });

      expect(response.status).toBe(400);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(login).not.toHaveBeenCalled();
    });

    it('carries no tenant field a caller could set', async () => {
      await request(server)
        .post('/api/v1/auth/login')
        .send({ ...CREDENTIALS, tenantId: '00000000-0000-7000-8000-000000000000' });

      // Unknown keys are stripped by the contract's schema, so the extra field
      // never reaches the service — the tenant comes from the request host.
      expect(login).toHaveBeenCalledWith(CREDENTIALS, expect.anything());
    });
  });

  describe('the authenticated routes', () => {
    it.each([
      ['GET', '/api/v1/auth/session'],
      ['POST', '/api/v1/auth/logout'],
      ['GET', '/api/v1/auth/sessions'],
      ['DELETE', `/api/v1/auth/sessions/${SESSION}`],
    ])('refuses %s %s with no session, without reaching a service', async (method, path) => {
      signedIn = false;

      const response =
        await request(server)[method.toLowerCase() as 'get' | 'post' | 'delete'](path);

      expect(response.status).toBe(401);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
      expect(logout).not.toHaveBeenCalled();
      expect(listOwn).not.toHaveBeenCalled();
    });

    it('GET /auth/session answers the caller, which is also the refresh', async () => {
      const response = await request(server).get('/api/v1/auth/session');

      expect(response.status).toBe(200);
      expect(SessionResponseSchema.parse(response.body).user).toEqual(PRINCIPAL);
    });

    it('POST /auth/logout answers 204 and clears both cookie spellings', async () => {
      const response = await request(server).post('/api/v1/auth/logout').send({});

      expect(response.status).toBe(204);
      expect(logout).toHaveBeenCalledWith(PRINCIPAL, false);

      const cleared = response.headers['set-cookie'] as unknown as string[];

      // Flipping SESSION_COOKIE_SECURE changes which name is issued; clearing
      // one and not the other leaves a dead cookie presented on every request.
      expect(cleared).toHaveLength(2);
      expect(cleared.every((header) => header.includes('Expires=Thu, 01 Jan 1970'))).toBe(true);
    });

    it('POST /auth/logout honours allSessions', async () => {
      await request(server).post('/api/v1/auth/logout').send({ allSessions: true });

      expect(logout).toHaveBeenCalledWith(PRINCIPAL, true);
    });

    it('GET /auth/sessions returns the caller’s own devices', async () => {
      listOwn.mockResolvedValue([
        {
          id: SESSION,
          createdAt: '2026-08-11T09:00:00.000Z',
          lastSeenAt: null,
          expiresAt: '2026-08-12T09:00:00.000Z',
          ipAddress: '203.0.113.7',
          userAgent: 'Firefox',
          current: true,
        },
      ]);

      const response = await request(server).get('/api/v1/auth/sessions');

      expect(response.status).toBe(200);
      expect(SessionListResponseSchema.parse(response.body)).toHaveLength(1);
      expect(listOwn).toHaveBeenCalledWith(PRINCIPAL);
    });

    it('DELETE /auth/sessions/{id} answers 204', async () => {
      const response = await request(server).delete(`/api/v1/auth/sessions/${SESSION}`);

      expect(response.status).toBe(204);
      expect(revokeOwn).toHaveBeenCalledWith(PRINCIPAL, SESSION);
    });

    it('DELETE /auth/sessions/{id} answers not_found for a session that is not the caller’s', async () => {
      revokeOwn.mockRejectedValue(new SessionNotFoundError(SESSION));

      const response = await request(server).delete(`/api/v1/auth/sessions/${SESSION}`);

      // `not_found`, never `forbidden`: a 403 would confirm the id exists.
      expect(response.status).toBe(404);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
    });

    it('DELETE /auth/sessions/{id} rejects an id that is not a uuid', async () => {
      const response = await request(server).delete('/api/v1/auth/sessions/not-a-uuid');

      expect(response.status).toBe(400);
      expect(revokeOwn).not.toHaveBeenCalled();
    });
  });
});
