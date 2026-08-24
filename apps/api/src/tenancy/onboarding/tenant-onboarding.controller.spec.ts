import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  OnboardingChecklistResponseSchema,
  permissionsForRole,
  type OnboardingChecklistResponse,
  type Permission,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../../bootstrap';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { AVAILABLE_WHILE_SUSPENDED } from '../../common/request-pipeline/route-access';
import { TenantContextMiddleware } from '../../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import { AllExceptionsFilter } from '../../observability/all-exceptions.filter';
import { AppLoggerService } from '../../observability/app-logger.service';
import { ErrorTrackingService } from '../../observability/error-tracking.service';
import { PermissionGuard } from '../../rbac/permission.guard';
import { PrincipalGuard } from '../../rbac/principal.guard';
import { ANONYMOUS, PRINCIPAL_SOURCE, resolved } from '../../rbac/principal.source';
import { REQUIRED_PERMISSIONS } from '../../rbac/require-permission.decorator';
import { TenantOnboardingController } from './tenant-onboarding.controller';
import { OnboardingStepCompletedError } from './tenant-onboarding.errors';
import { TenantOnboardingReader } from './tenant-onboarding.reader';
import { TenantOnboardingService } from './tenant-onboarding.service';

/**
 * The HTTP contract of the two onboarding routes (TAR-832, Interfaces).
 *
 * Through Express with the **real** `PrincipalGuard` and `PermissionGuard`
 * registered as `APP_GUARD`, the way `RequestPipelineModule` registers them,
 * because three of the things this endpoint has to get right are only visible
 * there: the auth matrix TAR-836 will re-run by hand, the `404` on an unknown
 * step id — which a Zod pipe would naturally render `400` — and the
 * `Cache-Control` that keeps one tenant's checklist out of a shared cache on a
 * path identical for every tenant.
 *
 * The reader and the writer are stubbed. What they compute has its own suite;
 * what is asserted here is the route.
 */

const TENANT = '83400000-0000-7000-8000-000000000021';
const ADMIN = '83400000-0000-7000-8000-0000000000b1';

const CHECKLIST: OnboardingChecklistResponse = {
  tenantId: TENANT,
  steps: [
    {
      id: 'connect_whatsapp',
      status: 'completed',
      completedAt: '2026-02-01T00:00:00.000Z',
      skippedAt: null,
    },
    { id: 'invite_agents', status: 'pending', completedAt: null, skippedAt: null },
    {
      id: 'set_branding',
      status: 'skipped',
      completedAt: null,
      skippedAt: '2026-05-01T00:00:00.000Z',
    },
  ],
  completedAt: null,
  updatedAt: '2026-05-01T00:00:00.000Z',
};

function principalWith(permissions: readonly Permission[]): SessionPrincipal {
  return {
    userId: ADMIN,
    tenantId: TENANT,
    email: 'admin@example.test',
    displayName: 'Avery Admin',
    role: 'admin',
    permissions: [...permissions],
    teamIds: [],
    sessionId: '83400000-0000-7000-8000-0000000000c1',
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

/**
 * A silent stand-in for `AppLoggerService`, for the reason
 * `reports.controller.spec.ts` records: `AllExceptionsFilter` writes to what
 * `structured()` returns, and `configureApp` passes the same object to
 * `app.useLogger`, so a stub missing `log` fails every case here pointing at
 * `init` rather than at itself.
 */
function silentLogger() {
  const pino = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };

  return {
    structured: () => pino,
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  };
}

describe('the onboarding checklist routes', () => {
  let app: INestApplication;
  let server: Server;
  let signedIn: boolean;
  let principal: SessionPrincipal;
  let read: jest.Mock;
  let apply: jest.Mock;

  beforeAll(async () => {
    read = jest.fn();
    apply = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [TenantOnboardingController],
      providers: [
        ApiExceptionFilter,
        { provide: TenantOnboardingReader, useValue: { read } },
        { provide: TenantOnboardingService, useValue: { apply } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PRINCIPAL_SOURCE,
          useValue: { resolve: () => Promise.resolve(signedIn ? resolved(principal) : ANONYMOUS) },
        },
        { provide: APP_GUARD, useClass: PrincipalGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: AppLoggerService, useValue: silentLogger() },
        { provide: ErrorTrackingService, useValue: { captureException: jest.fn() } },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
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
    principal = principalWith(permissionsForRole('admin'));
    read.mockResolvedValue(CHECKLIST);
    apply.mockResolvedValue(CHECKLIST);
  });

  const CHECKLIST_URL = '/api/v1/tenant/onboarding';
  const STEP_URL = `${CHECKLIST_URL}/steps/set_branding`;

  describe('who may reach them', () => {
    it('refuses an unauthenticated caller on the read', async () => {
      signedIn = false;

      const response = await request(server).get(CHECKLIST_URL).expect(401);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
      expect(read).not.toHaveBeenCalled();
    });

    it('refuses an unauthenticated caller on the write', async () => {
      signedIn = false;

      await request(server).patch(STEP_URL).send({ intent: 'skip' }).expect(401);
      expect(apply).not.toHaveBeenCalled();
    });

    it.each(['supervisor', 'agent'] as const)(
      'refuses a %s — 403, before the service',
      async (role) => {
        // `tenant:settings` is admin-only in `ROLE_PERMISSIONS`, and read and write
        // share it deliberately: putting a setup prompt off is not a second
        // authority.
        principal = { ...principalWith(permissionsForRole(role)), role };

        await request(server).get(CHECKLIST_URL).expect(403);
        await request(server).patch(STEP_URL).send({ intent: 'skip' }).expect(403);

        expect(read).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
      },
    );

    it('lets an admin in', async () => {
      await request(server).get(CHECKLIST_URL).expect(200);

      expect(read).toHaveBeenCalledWith(TENANT);
    });

    it('gates both routes on `tenant:settings`, and neither on the recovery allow-list', () => {
      const metadataOf = <T>(
        key: string,
        method: keyof TenantOnboardingController,
      ): T | undefined =>
        // eslint-disable-next-line @typescript-eslint/unbound-method
        Reflect.getMetadata(key, TenantOnboardingController.prototype[method]) as T | undefined;

      expect(metadataOf<readonly string[]>(REQUIRED_PERMISSIONS, 'read')).toEqual([
        'tenant:settings',
      ]);
      expect(metadataOf<readonly string[]>(REQUIRED_PERMISSIONS, 'updateStep')).toEqual([
        'tenant:settings',
      ]);
      // Deliberately off it: a suspended tenant's admin does not need to onboard,
      // and the allow-list exists so they can see why they are suspended.
      expect(metadataOf<boolean>(AVAILABLE_WHILE_SUSPENDED, 'read')).toBeUndefined();
      expect(metadataOf<boolean>(AVAILABLE_WHILE_SUSPENDED, 'updateStep')).toBeUndefined();
    });
  });

  describe('reading the checklist', () => {
    it('answers the published shape for the tenant in scope', async () => {
      const response = await request(server).get(CHECKLIST_URL).expect(200);

      expect(OnboardingChecklistResponseSchema.parse(response.body)).toEqual(CHECKLIST);
    });

    it('takes the tenant from the session, never from the request', async () => {
      // There is no field on either route for a caller to name one; this is the
      // assertion that keeps it that way.
      await request(server).get(`${CHECKLIST_URL}?tenantId=00000000-0000-7000-8000-000000000000`);

      expect(read).toHaveBeenCalledWith(TENANT);
    });

    it('marks the response uncacheable', async () => {
      // The path is identical for every tenant, so anything caching it on the URL
      // alone is a cross-tenant leak.
      const response = await request(server).get(CHECKLIST_URL).expect(200);

      expect(response.headers['cache-control']).toBe('private, no-store');
    });
  });

  describe('updating a step', () => {
    it('passes the step and the intent through, and answers the whole checklist', async () => {
      const response = await request(server).patch(STEP_URL).send({ intent: 'skip' }).expect(200);

      expect(apply).toHaveBeenCalledWith({
        tenantId: TENANT,
        stepId: 'set_branding',
        intent: 'skip',
      });
      expect(OnboardingChecklistResponseSchema.parse(response.body)).toEqual(CHECKLIST);
    });

    it('accepts `reopen` as well as `skip`', async () => {
      await request(server).patch(STEP_URL).send({ intent: 'reopen' }).expect(200);

      expect(apply).toHaveBeenCalledWith(expect.objectContaining({ intent: 'reopen' }));
    });

    it('answers 404 for a step id that is not one of the three', async () => {
      // Divergence 2, and the reason the path parameter does not go through
      // `ZodValidationPipe`: a path segment names a resource, and every other
      // resource route in this API answers 404 for one that does not exist.
      const response = await request(server)
        .patch(`${CHECKLIST_URL}/steps/import_contacts`)
        .send({ intent: 'skip' })
        .expect(404);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
      expect(apply).not.toHaveBeenCalled();
    });

    it('does not echo the step id it refused back to the caller', async () => {
      const response = await request(server)
        .patch(`${CHECKLIST_URL}/steps/%3Cscript%3E`)
        .send({ intent: 'skip' })
        .expect(404);

      expect(JSON.stringify(response.body)).not.toContain('script');
    });

    it.each([{}, { intent: 'completed' }, { intent: null }])(
      'refuses the body %j with a 400',
      async (body) => {
        // `completed` is the one worth naming: a client that could PATCH it would
        // let an admin mark a workspace set up that has no number attached.
        const response = await request(server).patch(STEP_URL).send(body).expect(400);

        expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
        expect(apply).not.toHaveBeenCalled();
      },
    );

    it('renders a skip of a completed step as 409', async () => {
      apply.mockRejectedValue(new OnboardingStepCompletedError('set_branding'));

      const response = await request(server).patch(STEP_URL).send({ intent: 'skip' }).expect(409);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('conflict');
    });

    it('marks the response uncacheable too', async () => {
      const response = await request(server).patch(STEP_URL).send({ intent: 'skip' }).expect(200);

      expect(response.headers['cache-control']).toBe('private, no-store');
    });
  });
});
