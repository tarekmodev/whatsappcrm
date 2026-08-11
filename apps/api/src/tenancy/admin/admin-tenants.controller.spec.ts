import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  DeactivatedTenantResponseSchema,
  ProvisionedTenantResponseSchema,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../../bootstrap';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import {
  REQUEST_ID_HEADER,
  TenantContextMiddleware,
} from '../../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../../common/tenant-context/tenant-context.module';
import { TenantNotFoundError } from '../tenant-deactivation.errors';
import {
  TenantDeactivationService,
  type DeactivateTenantResult,
} from '../tenant-deactivation.service';
import { PlatformHostnameTakenError } from '../tenant-provisioning.errors';
import {
  TenantProvisioningService,
  type ProvisionTenantResult,
} from '../tenant-provisioning.service';
import { AdminTenantsController } from './admin-tenants.controller';
import { PlatformAdminGuard } from './platform-admin.guard';

/**
 * The HTTP contract of the platform-admin tenant routes: who may call them,
 * what they accept, and the status codes that carry the outcome. Both services
 * are stubbed — their behaviour is covered by their own specs.
 */

const TOKEN = 'a-platform-admin-token-of-at-least-32-chars';
const TENANT_ID = '50444444-4444-7444-8444-4444444444c1';

const PROVISIONED: ProvisionTenantResult = {
  created: true,
  tenant: {
    id: TENANT_ID,
    slug: 'acme',
    name: 'Acme Ltd',
    status: 'active',
    primaryHostname: 'acme.app.example.com',
    timezone: 'UTC',
    locale: 'en',
    createdAt: new Date('2026-08-10T09:00:00.000Z'),
  },
};

const DEACTIVATED: DeactivateTenantResult = {
  deactivated: true,
  tenant: {
    id: TENANT_ID,
    slug: 'acme',
    name: 'Acme Ltd',
    status: 'suspended',
    suspendedAt: new Date('2026-08-10T10:00:00.000Z'),
  },
};

describe('the platform-admin tenant routes', () => {
  let app: INestApplication;
  let server: Server;
  let provision: jest.Mock;
  let deactivate: jest.Mock;

  beforeAll(async () => {
    provision = jest.fn();
    deactivate = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [AdminTenantsController],
      providers: [
        PlatformAdminGuard,
        ApiExceptionFilter,
        { provide: TenantProvisioningService, useValue: { provision } },
        { provide: TenantDeactivationService, useValue: { deactivate } },
        {
          provide: ConfigService,
          // Keyed rather than a blanket return: `configureApp` reads
          // `WEB_ORIGIN` from the same service and must get its own default.
          useValue: { get: (key: string) => (key === 'PLATFORM_ADMIN_TOKEN' ? TOKEN : undefined) },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    // The middleware the `AppModule` binds for every route. Bound by hand here
    // because this module is the controller under test rather than the whole
    // application — without it the error envelope has no request id to carry.
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
    provision.mockReset().mockResolvedValue(PROVISIONED);
    deactivate.mockReset().mockResolvedValue(DEACTIVATED);
  });

  describe('POST /api/v1/admin/tenants', () => {
    function post(body: object) {
      return request(server)
        .post('/api/v1/admin/tenants')
        .set('authorization', `Bearer ${TOKEN}`)
        .send(body);
    }

    it('answers 201 with the published response when it provisions', async () => {
      const response = await post({ slug: 'acme', name: 'Acme Ltd' }).expect(201);

      const body = ProvisionedTenantResponseSchema.parse(response.body);

      expect(body).toEqual({
        id: TENANT_ID,
        slug: 'acme',
        name: 'Acme Ltd',
        status: 'active',
        primaryHostname: 'acme.app.example.com',
        settings: { timezone: 'UTC', locale: 'en' },
        createdAt: '2026-08-10T09:00:00.000Z',
      });
    });

    it('answers 200 with the same body when the tenant already existed', async () => {
      provision.mockResolvedValue({ ...PROVISIONED, created: false });

      const response = await post({ slug: 'acme', name: 'Acme Ltd' }).expect(200);

      // Identical payload: an idempotent operation that reported a different
      // resource on replay would not be idempotent. The status carries the news.
      expect(ProvisionedTenantResponseSchema.parse(response.body).id).toBe(TENANT_ID);
    });

    it('passes only contract fields through, so a client cannot set what it does not own', async () => {
      await post({
        slug: 'acme',
        name: 'Acme Ltd',
        status: 'active',
        id: '00000000-0000-7000-8000-000000000000',
        primaryHostname: 'globex.app.example.com',
      }).expect(201);

      expect(provision).toHaveBeenCalledWith({ slug: 'acme', name: 'Acme Ltd' });
    });

    it('refuses an unauthenticated caller before it reaches provisioning', async () => {
      const response = await request(server)
        .post('/api/v1/admin/tenants')
        .send({ slug: 'acme', name: 'Acme Ltd' })
        .expect(401);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
      expect(provision).not.toHaveBeenCalled();
    });

    it('rejects an invalid body with field-level detail', async () => {
      const response = await post({ slug: '-acme', name: '' }).expect(400);

      const { error } = ApiErrorSchema.parse(response.body);

      expect(error.code).toBe('validation_failed');
      expect(error.details?.map((detail) => detail.path).sort()).toEqual(['name', 'slug']);
      expect(provision).not.toHaveBeenCalled();
    });

    it('reports a hostname claimed by another tenant as a conflict, not a fault', async () => {
      provision.mockRejectedValue(new PlatformHostnameTakenError('acme.app.example.com'));

      const response = await post({ slug: 'acme', name: 'Acme Ltd' }).expect(409);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('conflict');
    });

    it('correlates every error with the request id the caller can see', async () => {
      const response = await request(server)
        .post('/api/v1/admin/tenants')
        .set(REQUEST_ID_HEADER, 'req_from_caller')
        .send({})
        .expect(401);

      expect(ApiErrorSchema.parse(response.body).error.requestId).toBe('req_from_caller');
    });
  });

  describe('POST /api/v1/admin/tenants/{slug}/deactivate', () => {
    function deactivateRequest(slug: string, body: object = {}) {
      return request(server)
        .post(`/api/v1/admin/tenants/${slug}/deactivate`)
        .set('authorization', `Bearer ${TOKEN}`)
        .send(body);
    }

    it('answers 200 with the tenant it deactivated', async () => {
      const response = await deactivateRequest('acme').expect(200);

      expect(DeactivatedTenantResponseSchema.parse(response.body)).toEqual({
        id: TENANT_ID,
        slug: 'acme',
        name: 'Acme Ltd',
        status: 'suspended',
        suspendedAt: '2026-08-10T10:00:00.000Z',
      });
    });

    it('answers 200 again when the tenant was already deactivated', async () => {
      deactivate.mockResolvedValue({ ...DEACTIVATED, deactivated: false });

      const response = await deactivateRequest('acme').expect(200);

      // Same code and same body: the operation is idempotent, and reporting a
      // repeat as an error would make a retried script look like a failure.
      expect(DeactivatedTenantResponseSchema.parse(response.body).status).toBe('suspended');
    });

    it('passes the reason through to the audit trail, and nothing else', async () => {
      await deactivateRequest('acme', {
        reason: 'Non-payment',
        status: 'cancelled',
        suspendedAt: '2020-01-01T00:00:00.000Z',
      }).expect(200);

      // A caller cannot dictate the status it lands in or backdate the stamp:
      // unknown keys are stripped by the contract schema before the service
      // sees them.
      expect(deactivate).toHaveBeenCalledWith({ slug: 'acme', reason: 'Non-payment' });
    });

    it('accepts a call with no body at all', async () => {
      await deactivateRequest('acme').expect(200);

      expect(deactivate).toHaveBeenCalledWith({ slug: 'acme', reason: undefined });
    });

    it('rejects a slug that is not a slug, before it reaches the service', async () => {
      const response = await deactivateRequest('-acme').expect(400);

      const { error } = ApiErrorSchema.parse(response.body);

      expect(error.code).toBe('validation_failed');
      expect(error.details?.map((detail) => detail.path)).toEqual(['slug']);
      expect(deactivate).not.toHaveBeenCalled();
    });

    it('rejects a reason longer than the contract allows', async () => {
      await deactivateRequest('acme', { reason: 'x'.repeat(501) }).expect(400);

      expect(deactivate).not.toHaveBeenCalled();
    });

    it('reports an unknown tenant as not found, so a mistyped slug is visible', async () => {
      deactivate.mockRejectedValue(new TenantNotFoundError('globex'));

      const response = await deactivateRequest('globex').expect(404);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
    });

    it('refuses an unauthenticated caller before it reaches the service', async () => {
      const response = await request(server)
        .post('/api/v1/admin/tenants/acme/deactivate')
        .send({})
        .expect(401);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
      expect(deactivate).not.toHaveBeenCalled();
    });
  });
});
