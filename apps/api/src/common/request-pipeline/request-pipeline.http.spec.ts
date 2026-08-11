import type { Server } from 'node:http';
import { Controller, Get, Global, Logger, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ApiErrorSchema, permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../../bootstrap';
import { SYSTEM_PRISMA } from '../../prisma/prisma.tokens';
import {
  ANONYMOUS,
  PRINCIPAL_SOURCE,
  resolved,
  type PrincipalResolution,
  type PrincipalSource,
} from '../../rbac/principal.source';
import { AnyPrincipal, RequirePermission } from '../../rbac/require-permission.decorator';
import { ApiExceptionFilter } from '../errors/api-exception.filter';
import { TenantContextMiddleware } from '../tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { RequestPipelineModule } from './request-pipeline.module';
import { PlatformRoute, Public } from './route-access';

/**
 * TAR-58, end to end: the pipeline is installed globally, in the right order,
 * and a route is closed unless it says otherwise.
 *
 * These are the real `HostTenantGuard`, `PrincipalGuard` and `PermissionGuard`,
 * registered by the real `RequestPipelineModule`. Only the two things that need
 * infrastructure are faked — the domain lookup and the session read — because
 * what is under test is the *wiring*: which guards run, in which order, and what
 * a route has to do to get out of one. The guards' own decisions have their own
 * specs; the isolation they enforce at the data layer has `people-rbac.int-spec`
 * and `tenant-isolation.int-spec` against a real PostgreSQL.
 *
 * The probe controllers below stand in for the real ones deliberately. Asserting
 * against `UsersController` would couple this to TAR-22's permission table; what
 * matters here is that a controller which declares *nothing* is refused.
 */

const TENANT_A = '58111111-1111-7111-8111-111111111101';
const TENANT_B = '58111111-1111-7111-8111-111111111102';
const HOST_A = 'a.app.localhost';
const HOST_B = 'b.app.localhost';
const UNKNOWN_HOST = 'nobody.app.localhost';

function principalIn(tenantId: string): SessionPrincipal {
  return {
    userId: '58111111-1111-7111-8111-1111111111a1',
    tenantId,
    email: 'agent@example.invalid',
    displayName: 'Ada Agent',
    role: 'agent',
    permissions: [...permissionsForRole('agent')],
    teamIds: [],
    sessionId: '58111111-1111-7111-8111-1111111111f1',
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

/** A live session in tenant A, as `SessionReplayProbe` would report it. */
const REPLAYED = {
  sessionId: '58111111-1111-7111-8111-1111111111f1',
  tenantId: TENANT_A,
  userId: '58111111-1111-7111-8111-1111111111a1',
};

/** What the session cookie resolves to on the next request, set per test. */
let resolution: PrincipalResolution = ANONYMOUS;

const DOMAINS: Record<string, string> = { [HOST_A]: TENANT_A, [HOST_B]: TENANT_B };

/**
 * `@Global()` so `RequestPipelineModule` — which imports nothing, exactly as it
 * does in the application — can resolve these the way it resolves the real
 * `PrismaModule` and `RbacModule`.
 */
@Global()
@Module({
  providers: [
    {
      provide: SYSTEM_PRISMA,
      useValue: {
        tenantDomain: {
          findFirst: ({ where }: { where: { hostname: string } }) =>
            Promise.resolve(DOMAINS[where.hostname] ? { tenantId: DOMAINS[where.hostname] } : null),
        },
      },
    },
    {
      provide: PRINCIPAL_SOURCE,
      useValue: { resolve: () => Promise.resolve(resolution) } satisfies PrincipalSource,
    },
  ],
  exports: [SYSTEM_PRISMA, PRINCIPAL_SOURCE],
})
class PipelineFakesModule {}

/** A route that declares a permission: the ordinary tenant-facing shape. */
@Controller({ path: 'probe', version: '1' })
class GuardedProbeController {
  constructor(private readonly tenantContext: TenantContextService) {}

  @Get('guarded')
  @RequirePermission('conversation:read')
  guarded(): { tenantId: string; role: string; permissions: number } {
    const principal = this.tenantContext.requirePrincipal();

    return {
      tenantId: principal.tenantId,
      role: principal.role,
      permissions: principal.permissions.length,
    };
  }

  @Get('any-principal')
  @AnyPrincipal()
  anyPrincipal(): { ok: true } {
    return { ok: true };
  }

  @Get('admin-only')
  @RequirePermission('user:set_role')
  adminOnly(): { ok: true } {
    return { ok: true };
  }
}

/**
 * The controller this whole story exists for: it declares nothing at all — no
 * guards, no permission, no exemption — which is what a new endpoint looks like
 * before anybody has thought about authorization.
 */
@Controller({ path: 'probe', version: '1' })
class UndeclaredProbeController {
  @Get('undeclared')
  undeclared(): { ok: true } {
    return { ok: true };
  }
}

@Controller({ path: 'probe', version: '1' })
@Public()
class PublicProbeController {
  constructor(private readonly tenantContext: TenantContextService) {}

  @Get('public')
  publicRoute(): { tenantId: string | null } {
    return { tenantId: this.tenantContext.tenantId };
  }
}

/**
 * One class, two postures — `PasswordController`'s shape, where asking for a
 * reset link is reachable without a session and changing a password you already
 * know is not.
 *
 * Worth its own probe because the exemption is read with
 * `getAllAndOverride([handler, class])`: a route-level `@Public()` has to open
 * its own route and must not open the one declared beside it. A class-level
 * decorator, which `PublicProbeController` covers, cannot demonstrate either
 * half.
 */
@Controller({ path: 'probe', version: '1' })
class MixedPostureProbeController {
  @Get('mixed/public')
  @Public()
  publicRoute(): { ok: true } {
    return { ok: true };
  }

  @Get('mixed/authenticated')
  @AnyPrincipal()
  authenticatedRoute(): { ok: true } {
    return { ok: true };
  }
}

@Controller({ path: 'probe', version: '1' })
@PlatformRoute()
class PlatformProbeController {
  constructor(private readonly tenantContext: TenantContextService) {}

  @Get('platform')
  platformRoute(): { tenantId: string | null } {
    return { tenantId: this.tenantContext.tenantId };
  }
}

describe('the globally installed request pipeline', () => {
  let app: INestApplication;
  let server: Server;

  const errorCodeOf = (response: request.Response): string =>
    ApiErrorSchema.parse(response.body).error.code;

  /** One request, at `host`, with whatever session the current test set up. */
  function call(host: string) {
    return request.agent(server).set('Host', host);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule, PipelineFakesModule, RequestPipelineModule],
      controllers: [
        GuardedProbeController,
        UndeclaredProbeController,
        PublicProbeController,
        MixedPostureProbeController,
        PlatformProbeController,
      ],
      providers: [
        { provide: ConfigService, useValue: { get: () => undefined } },
        // Global here, where every controller under test would otherwise need
        // `@UseFilters`, so a guard's refusal renders the published envelope
        // whichever route it was thrown on. Anything that is not an
        // `ApiException` — the undeclared route's wiring error — falls through
        // to Nest's default and stays a 500.
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).compile();

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
    resolution = resolved(principalIn(TENANT_A));
  });

  /**
   * AC4, and the reason the story exists: the two controllers below never
   * declared a guard. One states a permission and works; the other states
   * nothing and is refused. Neither outcome depends on anybody remembering
   * `@UseGuards`.
   */
  describe('every route is behind it, without opting in', () => {
    it('admits a caller who holds the permission the route names', async () => {
      const response = await call(HOST_A).get('/api/v1/probe/guarded');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        tenantId: TENANT_A,
        role: 'agent',
        permissions: permissionsForRole('agent').length,
      });
    });

    it('refuses a route that declares no permission at all, rather than serving it', async () => {
      const response = await call(HOST_A).get('/api/v1/probe/undeclared');

      // A 500, and deliberately so: it is a wiring bug in *our* code, not
      // something the caller did wrong, and it fails closed and loudly the first
      // time anybody hits the route.
      expect(response.status).toBe(500);
    });

    it('refuses a signed-in caller who lacks the permission', async () => {
      const response = await call(HOST_A).get('/api/v1/probe/admin-only');

      expect(response.status).toBe(403);
      expect(errorCodeOf(response)).toBe('forbidden');
    });

    it('refuses a request with no session at all', async () => {
      resolution = ANONYMOUS;

      const response = await call(HOST_A).get('/api/v1/probe/guarded');

      expect(response.status).toBe(401);
      expect(errorCodeOf(response)).toBe('unauthenticated');
    });
  });

  /**
   * AC2: the header vector. The caller holds a real session for tenant A and
   * presents it at tenant B's hostname — the cheapest cross-tenant attempt there
   * is, and the one a `tenant_id` header would have made trivial.
   */
  describe('a session presented at another tenant’s host', () => {
    it.each([
      ['the source classified it', () => ({ outcome: 'replayed' as const, session: REPLAYED })],
      // Defence in depth: a source that resolved without RLS underneath it —
      // the interim role stub, or anything a later story binds — must not be
      // able to publish a caller from another tenant either.
      ['the source resolved it anyway', () => resolved(principalIn(TENANT_A))],
    ])('is refused with tenant_mismatch when %s', async (_label, build) => {
      resolution = build();

      const response = await call(HOST_B).get('/api/v1/probe/guarded');

      expect(response.status).toBe(401);
      expect(errorCodeOf(response)).toBe('tenant_mismatch');
      // The response carries none of it: not the other tenant, not the session.
      expect(JSON.stringify(response.body)).not.toContain(TENANT_A);
      expect(JSON.stringify(response.body)).not.toContain(REPLAYED.sessionId);
    });

    it('emits the security event, naming both tenants and the session’s user', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        resolution = { outcome: 'replayed', session: REPLAYED };

        await call(HOST_B).get('/api/v1/probe/guarded');

        const refusal = warn.mock.calls
          .map((call) => String(call[0]))
          .find((line) => line.includes('auth.tenant_mismatch'));

        expect(refusal).toBeDefined();
        expect(refusal).toContain(TENANT_A);
        expect(refusal).toContain(TENANT_B);
        expect(refusal).toContain(REPLAYED.userId);
        expect(refusal).toContain('/api/v1/probe/guarded');
      } finally {
        warn.mockRestore();
      }
    });
  });

  /**
   * The order is a contract and nothing enforces it at boot, so it is asserted
   * from the outside: an unknown host answers `tenant_not_found` — which only
   * `HostTenantGuard` can produce — even when there is also no session to find,
   * which is the answer `PrincipalGuard` would have given had it run first.
   */
  describe('the guards run in the published order', () => {
    it('answers tenant_not_found before it can answer unauthenticated', async () => {
      resolution = ANONYMOUS;

      const response = await call(UNKNOWN_HOST).get('/api/v1/probe/guarded');

      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('tenant_not_found');
    });

    it('answers tenant_not_found on a @Public() route too', async () => {
      // `@Public()` gives up the session, not the tenant. Login has to know
      // which tenant it is authenticating against.
      const response = await call(UNKNOWN_HOST).get('/api/v1/probe/public');

      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('tenant_not_found');
    });
  });

  describe('the two exemptions', () => {
    it('@Public() serves without a session, with the tenant still resolved', async () => {
      resolution = ANONYMOUS;

      const response = await call(HOST_A).get('/api/v1/probe/public');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ tenantId: TENANT_A });
    });

    it('@Public() on one route opens that route and not the one beside it', async () => {
      resolution = ANONYMOUS;

      const open = await call(HOST_A).get('/api/v1/probe/mixed/public');
      const closed = await call(HOST_A).get('/api/v1/probe/mixed/authenticated');

      expect(open.status).toBe(200);
      expect(closed.status).toBe(401);
      expect(errorCodeOf(closed)).toBe('unauthenticated');
    });

    it('@PlatformRoute() serves at an unknown host with no session and no tenant', async () => {
      resolution = ANONYMOUS;

      const response = await call(UNKNOWN_HOST).get('/api/v1/probe/platform');

      expect(response.status).toBe(200);
      // Nothing in scope, so `TenantPrisma` refuses every statement — a platform
      // route that reaches for tenant data fails closed rather than reading
      // whichever tenant happened to be resolved.
      expect(response.body).toEqual({ tenantId: null });
    });
  });

  /**
   * AC3: the role claim is resolved from the session and published for
   * downstream authorization. `PermissionGuard` is the first consumer, and
   * TAR-22's console reads the same array off `GET /auth/session`.
   */
  it('publishes the session’s role and permissions for downstream checks', async () => {
    resolution = resolved({ ...principalIn(TENANT_A), role: 'admin' });

    const response = await call(HOST_A).get('/api/v1/probe/guarded');

    expect(response.body).toMatchObject({ role: 'admin', tenantId: TENANT_A });
  });
});
