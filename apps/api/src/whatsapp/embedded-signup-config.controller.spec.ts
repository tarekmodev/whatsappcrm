import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  WhatsAppEmbeddedSignupConfigResponseSchema,
  permissionsForRole,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { ANONYMOUS, PRINCIPAL_SOURCE, resolved } from '../rbac/principal.source';
import { WhatsAppEmbeddedSignupConfigController } from './embedded-signup-config.controller';

/**
 * `GET /api/v1/whatsapp/embedded-signup/config` — what the console reads
 * instead of the two `NEXT_PUBLIC_*` constants Next.js inlines at build time
 * (TAR-816).
 *
 * Two things are asserted. That the values come from
 * `PlatformSettingsService` — otherwise a runtime edit changes nothing the
 * browser can see, which is the failure mode this endpoint exists to prevent.
 * And that the route stands on the real pipeline guards, registered as
 * `APP_GUARD` the way `RequestPipelineModule` registers them.
 *
 * `HostTenantGuard` needs a database, so the middleware below stands in for it.
 */

const TENANT_ID = '50444444-4444-7444-8444-4444444444c1';
const APP_ID = '1234567890123456';
const CONFIG_ID = '9876543210987654';
const VERSION = 'v23.0';

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

describe('GET /api/v1/whatsapp/embedded-signup/config', () => {
  let app: INestApplication;
  let server: Server;
  let get: jest.Mock;
  let principal: SessionPrincipal | null;

  beforeAll(async () => {
    get = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [WhatsAppEmbeddedSignupConfigController],
      providers: [
        ApiExceptionFilter,
        { provide: PlatformSettingsService, useValue: { get } },
        {
          provide: ConfigService,
          useValue: {
            get: () => undefined,
            getOrThrow: (key: string) =>
              key === 'META_GRAPH_API_VERSION' ? VERSION : (undefined as unknown as string),
          },
        },
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
    get
      .mockReset()
      .mockImplementation((key: string) =>
        key === 'meta.app_id'
          ? APP_ID
          : key === 'meta.embedded_signup_config_id'
            ? CONFIG_ID
            : null,
      );
  });

  function read() {
    return request(server).get('/api/v1/whatsapp/embedded-signup/config');
  }

  it('serves the two ids from the settings snapshot, not from a build-time constant', async () => {
    // The whole point: an operator's edit reaches the browser on the next page
    // load rather than on the next deploy.
    const response = await read().expect(200);

    expect(WhatsAppEmbeddedSignupConfigResponseSchema.parse(response.body)).toEqual({
      appId: APP_ID,
      configId: CONFIG_ID,
      graphApiVersion: VERSION,
    });

    expect(get).toHaveBeenCalledWith('meta.app_id');
    expect(get).toHaveBeenCalledWith('meta.embedded_signup_config_id');
  });

  it('reports null for an unconfigured environment rather than omitting the field', async () => {
    // The console has to render "not available here"; a missing field would read
    // as a malformed response instead.
    get.mockReturnValue(null);

    const response = await read().expect(200);

    expect(WhatsAppEmbeddedSignupConfigResponseSchema.parse(response.body)).toEqual({
      appId: null,
      configId: null,
      graphApiVersion: VERSION,
    });
  });

  it('refuses a request with no session', async () => {
    principal = null;

    const response = await read();

    expect(response.status).toBe(401);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
  });

  it('refuses a signed-in caller without channel:manage', async () => {
    // Neither value is a secret, but an endpoint reporting how this platform's
    // Meta app is configured is reconnaissance for no gain.
    principal = principalWith('agent');

    const response = await read();

    expect(response.status).toBe(403);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('forbidden');
  });

  it('never carries the app secret, which is what completes the exchange', async () => {
    get.mockImplementation((key: string) =>
      key === 'whatsapp.app_secret' ? 'the-meta-app-secret-value-0123456789' : APP_ID,
    );

    const response = await read().expect(200);

    expect(JSON.stringify(response.body)).not.toContain('the-meta-app-secret-value');
  });
});
