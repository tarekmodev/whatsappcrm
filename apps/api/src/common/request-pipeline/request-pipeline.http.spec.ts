import type { Server } from 'node:http';
import { Controller, Get, Global, Logger, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  permissionsForRole,
  type SessionPrincipal,
  type TenantStatus,
} from '@whatsappcrm/contracts';
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
import { AvailableWhileSuspended, PlatformRoute, Public } from './route-access';

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
/** Suspended throughout: the subject of stage 4 (TAR-36, ADR 0009 decision 2). */
const TENANT_SUSPENDED = '58111111-1111-7111-8111-111111111103';
/** Purged. `HostTenantGuard` answers `tenant_not_found` before stage 4 sees it. */
const TENANT_DELETED = '58111111-1111-7111-8111-111111111104';
const HOST_A = 'a.app.localhost';
const HOST_B = 'b.app.localhost';
const HOST_SUSPENDED = 'suspended.app.localhost';
const HOST_DELETED = 'gone.app.localhost';
const UNKNOWN_HOST = 'nobody.app.localhost';

/**
 * What every deployed request actually arrives at: Render routes by `Host` at its
 * edge and tenant domains hang off the *web* service, so the API only ever sees
 * its own host. It is not a tenant domain, which is the whole problem TAR-148
 * fixes — and it makes it visible in these tests when a forwarded host was
 * honoured and when it was not.
 */
const API_HOST = 'whatsappcrm-api.onrender.invalid';

/** Stands in for `TRUSTED_PROXY_SECRET`, and for the previous value it rotates from. */
const EDGE_SECRET = 'e'.repeat(64);
const PREVIOUS_EDGE_SECRET = 'p'.repeat(64);

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

/**
 * Hostname → the row `HostTenantGuard` reads, which since TAR-404 carries the
 * tenant's lifecycle status: the guard publishes it for stage 4 rather than
 * making stage 4 issue a second query per request.
 */
const DOMAINS: Record<string, { tenantId: string; tenant: { status: TenantStatus } }> = {
  [HOST_A]: { tenantId: TENANT_A, tenant: { status: 'active' } },
  [HOST_B]: { tenantId: TENANT_B, tenant: { status: 'active' } },
  [HOST_SUSPENDED]: { tenantId: TENANT_SUSPENDED, tenant: { status: 'suspended' } },
  [HOST_DELETED]: { tenantId: TENANT_DELETED, tenant: { status: 'deleted' } },
};

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
            Promise.resolve(DOMAINS[where.hostname] ?? null),
        },
      },
    },
    {
      provide: PRINCIPAL_SOURCE,
      useValue: { resolve: () => Promise.resolve(resolution) } satisfies PrincipalSource,
    },
    {
      provide: ConfigService,
      useValue: {
        // `HostTenantGuard` reads both at construction, so the secret is fixed
        // for the whole suite and it is the *headers* each test varies.
        get: (key: string) =>
          ({
            TRUSTED_PROXY_SECRET: EDGE_SECRET,
            TRUSTED_PROXY_SECRET_PREVIOUS: PREVIOUS_EDGE_SECRET,
          })[key],
      },
    },
  ],
  exports: [SYSTEM_PRISMA, PRINCIPAL_SOURCE, ConfigService],
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

/**
 * Stage 4's two shapes: an ordinary route, and one on the recovery allowlist.
 *
 * The allowlisted route declares its permission exactly as the other does —
 * `@AvailableWhileSuspended()` is not a posture and gives up nothing except
 * `TenantStatusGuard`'s refusal, which is what makes `route-posture.spec.ts`
 * still count exactly one posture on it.
 */
@Controller({ path: 'probe', version: '1' })
class LifecycleProbeController {
  @Get('while-suspended')
  @AnyPrincipal()
  @AvailableWhileSuspended()
  recoverable(): { ok: true } {
    return { ok: true };
  }

  @Get('ordinary')
  @AnyPrincipal()
  ordinary(): { ok: true } {
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
        LifecycleProbeController,
        PlatformProbeController,
      ],
      providers: [
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

  /**
   * TAR-148. The API never sees a tenant `Host` in a deployed environment, so the
   * web tier forwards it — and the only thing separating that from letting a
   * caller name its own tenant is `x-edge-auth`. Every case below arrives at
   * `API_HOST`, exactly as a real one does, so a pass means the forwarded value
   * was honoured and a `tenant_not_found` means it was not.
   *
   * The header names are written out rather than imported from
   * `@whatsappcrm/contracts` on purpose, even though the guard reads them from
   * there. These send what a real client sends, so a rename has to break this
   * spec rather than follow it silently — the same reason `contract.test.ts`
   * pins the literal spellings instead of comparing a constant to itself.
   */
  describe('a forwarded host', () => {
    it('resolves the tenant when the caller presents the shared secret', async () => {
      const response = await call(API_HOST)
        .set('x-edge-auth', EDGE_SECRET)
        .set('x-edge-host', HOST_A)
        .get('/api/v1/probe/guarded');

      // Tenant A, from a request whose own `Host` belongs to no tenant at all.
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ tenantId: TENANT_A });
    });

    it('is what the session is checked against, not the host the request arrived at', async () => {
      // The session is tenant A's; the trusted edge says the request is tenant
      // B's. `PrincipalGuard` refuses it — which it can only do if stage 1
      // resolved B from the forwarded value.
      const response = await call(API_HOST)
        .set('x-edge-auth', EDGE_SECRET)
        .set('x-edge-host', HOST_B)
        .get('/api/v1/probe/guarded');

      expect(response.status).toBe(401);
      expect(errorCodeOf(response)).toBe('tenant_mismatch');
    });

    it('still strips the port and lowercases what it was given', async () => {
      const response = await call(API_HOST)
        .set('x-edge-auth', EDGE_SECRET)
        .set('x-edge-host', 'A.App.LocalHost:3000')
        .get('/api/v1/probe/guarded');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ tenantId: TENANT_A });
    });

    it('accepts the previous secret too, so rotating it is three ordinary deploys', async () => {
      const response = await call(API_HOST)
        .set('x-edge-auth', PREVIOUS_EDGE_SECRET)
        .set('x-edge-host', HOST_A)
        .get('/api/v1/probe/guarded');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ tenantId: TENANT_A });
    });

    it.each([
      ['no x-edge-auth at all', {}],
      ['a wrong x-edge-auth', { 'x-edge-auth': 'f'.repeat(64) }],
      ['an empty x-edge-auth', { 'x-edge-auth': '' }],
    ])('is ignored outright when the caller presents %s', async (_label, headers) => {
      const response = await call(API_HOST)
        .set(headers)
        .set('x-edge-host', HOST_A)
        .get('/api/v1/probe/guarded');

      // Falls back to `Host` — never to the value the caller chose. A tenant that
      // exists is not reachable this way, so the answer is the same one an
      // unknown domain gets.
      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('tenant_not_found');
    });

    it('says so at warn when the secret matches neither, once per window', async () => {
      // The likely cause is not an attacker: it is the two services holding
      // different values after a rotation, and in that state the boot line still
      // reads `enabled` while every tenant route 404s. `Date.now` is pinned so
      // the assertion does not depend on which test spent the throttle window.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const now = jest.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);

      try {
        const forged = (): Promise<request.Response> =>
          call(API_HOST)
            .set('x-edge-auth', 'f'.repeat(64))
            .set('x-edge-host', HOST_A)
            .get('/api/v1/probe/guarded');

        await forged();
        await forged();

        const refusals = warn.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('tenancy.edge_auth_mismatch'));

        // Two refusals, one line: the path is reachable unauthenticated, and a
        // log an anonymous caller can fill is its own availability problem.
        expect(refusals).toHaveLength(1);
        // The fact, never the value — neither the presented one nor ours.
        expect(refusals[0]).not.toContain('f'.repeat(64));
        expect(refusals[0]).not.toContain(EDGE_SECRET);
        expect(refusals[0]).not.toContain(PREVIOUS_EDGE_SECRET);
      } finally {
        now.mockRestore();
        warn.mockRestore();
      }
    });

    it('is refused when it carries more than one value, rather than taking the first', async () => {
      // Leftmost-wins is how forwarded-header splicing gets in: a caller upstream
      // of the edge appends its own value and the API reads the wrong half.
      const response = await call(API_HOST)
        .set('x-edge-auth', EDGE_SECRET)
        .set('x-edge-host', `${HOST_A}, ${HOST_B}`)
        .get('/api/v1/probe/guarded');

      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('tenant_not_found');
    });

    it('is not read from x-forwarded-host, whatever the caller presents', async () => {
      // The pair is two private names on purpose. `x-forwarded-host` is a
      // standard header every proxy between the web tier and the API is entitled
      // to set or overwrite, and the hop between them is a public one — so it is
      // not read here at all, gated or otherwise.
      const response = await call(API_HOST)
        .set('x-edge-auth', EDGE_SECRET)
        .set('x-forwarded-host', HOST_A)
        .get('/api/v1/probe/guarded');

      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('tenant_not_found');
    });

    it('falls back to Host when a trusted caller names no host', async () => {
      // A probe that reached the API service directly looks like this. `Host` is
      // the honest answer, and here it belongs to a real tenant.
      const response = await call(HOST_A)
        .set('x-edge-auth', EDGE_SECRET)
        .get('/api/v1/probe/guarded');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ tenantId: TENANT_A });
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
   * Stage 4, end to end (TAR-36, ADR 0009 decision 2).
   *
   * After Amendment 1 ruling 1 the database gate admits a suspended tenant, so
   * `TenantStatusGuard` is the **only** thing between that tenant's agent and
   * the API. These assertions are the ones that make the lockout real rather
   * than inherited from a data layer that no longer refuses.
   */
  describe('stage 4 — the tenant’s lifecycle status', () => {
    it('refuses an agent of a suspended tenant, whatever route they ask for', async () => {
      resolution = resolved(principalIn(TENANT_SUSPENDED));

      const response = await call(HOST_SUSPENDED).get('/api/v1/probe/ordinary');

      expect(response.status).toBe(402);
      expect(errorCodeOf(response)).toBe('subscription_inactive');
    });

    it('refuses an agent even on a route marked available while suspended', async () => {
      // The decorator alone would open the route to every agent in the tenant,
      // which is TAR-36's fourth acceptance criterion inverted. Both halves are
      // required: the route says so, *and* the caller is an admin.
      resolution = resolved(principalIn(TENANT_SUSPENDED));

      const response = await call(HOST_SUSPENDED).get('/api/v1/probe/while-suspended');

      expect(response.status).toBe(402);
    });

    it('lets an admin through on the recovery allowlist, so they can pay their way out', async () => {
      resolution = resolved({ ...principalIn(TENANT_SUSPENDED), role: 'admin' });

      const response = await call(HOST_SUSPENDED).get('/api/v1/probe/while-suspended');

      expect(response.status).toBe(200);
    });

    it('refuses that same admin everywhere else, so a suspension is still a suspension', async () => {
      resolution = resolved({ ...principalIn(TENANT_SUSPENDED), role: 'admin' });

      const response = await call(HOST_SUSPENDED).get('/api/v1/probe/ordinary');

      expect(response.status).toBe(402);
      expect(errorCodeOf(response)).toBe('subscription_inactive');
    });

    it('leaves an active tenant alone', async () => {
      resolution = resolved(principalIn(TENANT_A));

      await call(HOST_A).get('/api/v1/probe/ordinary').expect(200);
    });

    it('answers tenant_not_found for a purged tenant, before stage 4 is reached', async () => {
      // `deleted` never reaches the status guard: a tombstone must not be
      // distinguishable from a hostname that never belonged to anybody, or the
      // 402 itself confirms a tenant once existed here.
      resolution = ANONYMOUS;

      const response = await call(HOST_DELETED).get('/api/v1/probe/ordinary');

      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('tenant_not_found');
    });

    it('runs after the principal is resolved, so an anonymous caller is still unauthenticated', async () => {
      // Ordering: `unauthenticated` before `subscription_inactive`. Answering the
      // lifecycle first would tell an unauthenticated caller the state of a
      // tenant they have no session for.
      resolution = ANONYMOUS;

      const response = await call(HOST_SUSPENDED).get('/api/v1/probe/ordinary');

      expect(response.status).toBe(401);
      expect(errorCodeOf(response)).toBe('unauthenticated');
    });

    it('runs before the permission check, so the truer answer is the one returned', async () => {
      // An agent of a suspended tenant asking for an admin-only route gets
      // `subscription_inactive` rather than `forbidden`: their workspace being
      // suspended is what they need to know, and it is what they can act on.
      resolution = resolved(principalIn(TENANT_SUSPENDED));

      const response = await call(HOST_SUSPENDED).get('/api/v1/probe/admin-only');

      expect(errorCodeOf(response)).toBe('subscription_inactive');
    });

    it('does not run on a @Public() route, because login has to authenticate first', async () => {
      // ADR 0009 decision 2: checking the status before a password is verified
      // turns login into a role oracle. The lifecycle check for login lives in
      // `AuthService`, after the principal is resolved.
      resolution = ANONYMOUS;

      await call(HOST_SUSPENDED).get('/api/v1/probe/public').expect(200);
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
