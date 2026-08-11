import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  InvitePreviewResponseSchema,
  InviteResponseSchema,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME_SECURE,
  SessionResponseSchema,
  permissionsForRole,
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
import { HostTenantGuard } from '../tenancy/host-tenant.guard';
import { InviteTokenInvalidError } from './identity.errors';
import { InviteService } from './invite.service';
import { InvitesController } from './invites.controller';
import { UserInvitesController } from './user-invites.controller';

/**
 * The HTTP contract of the invite routes: statuses, the error envelope, and the
 * cookie.
 *
 * The cookie assertions are the load-bearing ones. Everything else here would
 * fail visibly in a browser during development; a missing `HttpOnly`, a stray
 * `Domain` or a session token echoed into the response body would not — they
 * would work perfectly and be a credential-exposure bug.
 */

const TENANT_ID = '0192f0ff-0000-7000-8000-0000000000b1';
const INVITE_ID = '0192f0ff-0000-7000-8000-00000000c001';
const USER_ID = '0192f0ff-0000-7000-8000-00000000a009';
const SESSION_TOKEN = 'Zm9yLXRoZS1jb29raWUtb25seS1uZXZlci10aGUtYm9keQ';

const PRINCIPAL: SessionPrincipal = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  email: 'noor@example.invalid',
  displayName: 'Noor Sayed',
  role: 'agent',
  permissions: [...permissionsForRole('agent')],
  teamIds: [],
  sessionId: '0192f0ff-0000-7000-8000-0000000000fe',
  expiresAt: '2026-12-31T23:59:59.000Z',
};

const INVITE = {
  id: INVITE_ID,
  email: 'noor@example.invalid',
  role: 'agent' as const,
  invitedByUserId: '0192f0ff-0000-7000-8000-00000000a001',
  teamIds: [],
  expiresAt: '2026-08-18T10:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-08-11T10:00:00.000Z',
};

describe('invite routes', () => {
  let app: INestApplication;
  let server: Server;
  let create: jest.Mock;
  let preview: jest.Mock;
  let accept: jest.Mock;
  let revoke: jest.Mock;

  /**
   * A configured application.
   *
   * `secure` is read once, in the controller's constructor, exactly as
   * `AuthController` reads it — it is boot configuration, not a per-request
   * decision. So the one test that needs it off builds its own app rather than
   * flipping a variable the constructor has already read.
   */
  async function buildApp(secure: boolean): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [InvitesController, UserInvitesController],
      providers: [
        ApiExceptionFilter,
        {
          provide: InviteService,
          useValue: { create, preview, accept, revoke, list: jest.fn(), resend: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'SESSION_COOKIE_SECURE' ? secure : 'http://localhost:3000',
          },
        },
      ],
    })
      // The guards have their own specs and their own dependencies (the system
      // client, the principal source). What is under test here is what the
      // controllers do once a request is through them.
      .overrideGuard(HostTenantGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PrincipalGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    jest
      .spyOn(TenantContextService.prototype, 'tenantId', 'get')
      .mockImplementation(() => TENANT_ID);

    const built = moduleRef.createNestApplication();

    const middleware = built.get(TenantContextMiddleware);
    built.use(middleware.use.bind(middleware));

    configureApp(built);
    await built.init();

    return built;
  }

  beforeAll(async () => {
    create = jest.fn();
    preview = jest.fn();
    accept = jest.fn();
    revoke = jest.fn();

    app = await buildApp(true);
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    create.mockReset().mockResolvedValue({ invite: INVITE, created: true });
    preview.mockReset().mockResolvedValue({
      email: INVITE.email,
      role: 'agent',
      expiresAt: INVITE.expiresAt,
      tenantName: 'Acme Support',
      invitedByName: 'Ada Admin',
    });
    accept.mockReset().mockResolvedValue({ principal: PRINCIPAL, sessionToken: SESSION_TOKEN });
    revoke.mockReset().mockResolvedValue(undefined);
  });

  function acceptRequest() {
    return request(server).post('/api/v1/invites/accept').send({
      token: 'a-token-that-only-the-invitee-holds',
      displayName: 'Noor Sayed',
      password: 'a-perfectly-adequate-password',
    });
  }

  describe('POST /api/v1/invites/accept', () => {
    it('answers the session principal and sets the cookie', async () => {
      const response = await acceptRequest();

      expect(response.status).toBe(200);
      expect(SessionResponseSchema.parse(response.body)).toEqual({ user: PRINCIPAL });
    });

    it('keeps the session token out of the response body', async () => {
      const response = await acceptRequest();

      expect(JSON.stringify(response.body)).not.toContain(SESSION_TOKEN);
    });

    it('sets an httpOnly, SameSite=Lax, path-scoped cookie with no Domain', async () => {
      const [cookie] = await acceptCookies();

      expect(cookie).toContain(`${SESSION_COOKIE_NAME_SECURE}=${SESSION_TOKEN}`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
      // A `Domain` would send this tenant's session to every sibling subdomain,
      // and a browser rejects a `__Host-` cookie that carries one outright.
      expect(cookie).not.toContain('Domain');
    });

    it('drops the __Host- prefix and Secure only when the deployment is not on TLS', async () => {
      const plain = await buildApp(false);

      try {
        const response = await request(plain.getHttpServer() as Server)
          .post('/api/v1/invites/accept')
          .send({
            token: 'a-token-that-only-the-invitee-holds',
            displayName: 'Noor Sayed',
            password: 'a-perfectly-adequate-password',
          });
        const header = response.headers['set-cookie'];
        const [cookie] = Array.isArray(header) ? header : [String(header)];

        expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
        expect(cookie).not.toContain(SESSION_COOKIE_NAME_SECURE);
        expect(cookie).not.toContain('Secure');
      } finally {
        await plain.close();
      }
    });

    it('rejects a password below the published minimum before reaching the service', async () => {
      const response = await request(server)
        .post('/api/v1/invites/accept')
        .send({ token: 'a-token', displayName: 'Noor', password: 'short' });

      expect(response.status).toBe(400);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(accept).not.toHaveBeenCalled();
    });

    it('answers 410 token_invalid, naming why, when the link no longer works', async () => {
      accept.mockRejectedValue(new InviteTokenInvalidError('expired'));

      const response = await acceptRequest();

      expect(response.status).toBe(410);

      const { error } = ApiErrorSchema.parse(response.body);

      expect(error.code).toBe('token_invalid');
      expect(error.details).toEqual([{ path: 'token', message: 'expired' }]);
    });

    async function acceptCookies(): Promise<string[]> {
      const response = await acceptRequest();
      const header = response.headers['set-cookie'];

      return Array.isArray(header) ? header : [String(header)];
    }
  });

  describe('POST /api/v1/invites/lookup', () => {
    it('previews the invitation for the accept screen', async () => {
      const response = await request(server)
        .post('/api/v1/invites/lookup')
        .send({ token: 'a-token-that-only-the-invitee-holds' });

      expect(response.status).toBe(200);
      expect(InvitePreviewResponseSchema.parse(response.body).tenantName).toBe('Acme Support');
    });

    it('answers 410 rather than 404 for an unknown token', async () => {
      preview.mockRejectedValue(new InviteTokenInvalidError('unknown'));

      const response = await request(server).post('/api/v1/invites/lookup').send({ token: 'nope' });

      expect(response.status).toBe(410);
    });
  });

  describe('POST /api/v1/users/invites', () => {
    it('answers 201 when it wrote a new invitation', async () => {
      const response = await request(server)
        .post('/api/v1/users/invites')
        .send({ email: 'noor@example.invalid', role: 'agent' });

      expect(response.status).toBe(201);
      expect(InviteResponseSchema.parse(response.body).id).toBe(INVITE_ID);
    });

    it('answers 200 when it refreshed the one that was already there', async () => {
      create.mockResolvedValue({ invite: INVITE, created: false });

      const response = await request(server)
        .post('/api/v1/users/invites')
        .send({ email: 'noor@example.invalid', role: 'agent' });

      expect(response.status).toBe(200);
    });

    it('never returns the token, whatever the service hands back', async () => {
      const response = await request(server)
        .post('/api/v1/users/invites')
        .send({ email: 'noor@example.invalid', role: 'agent' });

      expect(Object.keys(response.body as object)).not.toContain('token');
    });

    it('rejects a role outside the published vocabulary', async () => {
      const response = await request(server)
        .post('/api/v1/users/invites')
        .send({ email: 'noor@example.invalid', role: 'owner' });

      expect(response.status).toBe(400);
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/v1/users/invites/{id}', () => {
    it('answers 204 with no body', async () => {
      const response = await request(server).delete(`/api/v1/users/invites/${INVITE_ID}`);

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
      expect(revoke).toHaveBeenCalledWith(INVITE_ID);
    });

    it('rejects an id that is not a uuid before reaching the service', async () => {
      const response = await request(server).delete('/api/v1/users/invites/not-a-uuid');

      expect(response.status).toBe(400);
      expect(revoke).not.toHaveBeenCalled();
    });
  });
});
