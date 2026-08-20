import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  ConnectedWhatsAppBusinessAccountResponseSchema,
  SyncMessageTemplatesResponseSchema,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../../bootstrap';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../../common/tenant-context/tenant-context.module';
import { TenantNotActiveError } from '../../prisma/prisma.errors';
import { AdminTenantScopeService } from '../../tenancy/admin/admin-tenant-scope.service';
import { PlatformAdminGuard } from '../../tenancy/admin/platform-admin.guard';
import { TenantNotFoundError } from '../../tenancy/tenant-deactivation.errors';
import {
  WhatsAppBusinessAccountConnectionService,
  type ConnectBusinessAccountResult,
} from '../business-account-connection.service';
import {
  MessageTemplateSyncService,
  type SyncMessageTemplatesResult,
} from '../message-template-sync.service';
import {
  MetaAuthenticationError,
  MetaRateLimitedError,
  MetaUnavailableError,
} from '../meta-cloud-api.errors';
import {
  WhatsAppBusinessAccountNotFoundError,
  WhatsAppIdentityTakenError,
  WhatsAppTokenUndecryptableError,
} from '../whatsapp.errors';
import { AdminWhatsAppController } from './admin-whatsapp.controller';

/**
 * The HTTP contract of the platform-admin WhatsApp routes: who may call them,
 * what they accept, which status codes carry the outcome, and — the one worth
 * being loudest about — that no response ever contains the access token. The
 * services are stubbed; their behaviour is covered by their own specs.
 */

/** The secret half of a `PLATFORM_ADMIN_TOKEN` entry — what a caller presents. */
const TOKEN = 'a-platform-admin-token-of-at-least-32-chars';
/** What the environment holds: the same secret, named (TAR-166). */
const CONFIGURED = `ops-alice:${TOKEN}`;
const TENANT_ID = '50444444-4444-7444-8444-4444444444c1';
const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';
const WABA_ID = '102290129340398';
const ACCESS_TOKEN = 'EAAG-a-real-looking-meta-access-token';
const TIMESTAMP = new Date('2026-08-10T09:00:00.000Z');

const CONNECT_BODY = {
  wabaId: WABA_ID,
  name: 'Acme Ltd',
  accessToken: ACCESS_TOKEN,
  phoneNumbers: [{ phoneNumberId: '15550001111', displayPhoneNumber: '+15550001111' }],
};

const CONNECTED: ConnectBusinessAccountResult = {
  created: true,
  businessAccount: {
    id: WABA_ROW_ID,
    wabaId: WABA_ID,
    name: 'Acme Ltd',
    verificationStatus: 'not_verified',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    accounts: [
      {
        id: '70444444-4444-7444-8444-444444444401',
        whatsappBusinessAccountId: WABA_ROW_ID,
        phoneNumberId: '15550001111',
        displayPhoneNumber: '+15550001111',
        verifiedName: null,
        qualityRating: null,
        status: 'connected',
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
  },
};

const SYNCED: SyncMessageTemplatesResult = {
  whatsappBusinessAccountId: WABA_ROW_ID,
  wabaId: WABA_ID,
  created: 3,
  updated: 1,
  skipped: 0,
  total: 4,
  syncedAt: TIMESTAMP,
};

describe('the platform-admin WhatsApp routes', () => {
  let app: INestApplication;
  let server: Server;
  let enter: jest.Mock;
  let connect: jest.Mock;
  let syncByWabaId: jest.Mock;

  beforeAll(async () => {
    enter = jest.fn();
    connect = jest.fn();
    syncByWabaId = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [AdminWhatsAppController],
      providers: [
        PlatformAdminGuard,
        ApiExceptionFilter,
        { provide: AdminTenantScopeService, useValue: { enter } },
        { provide: WhatsAppBusinessAccountConnectionService, useValue: { connect } },
        { provide: MessageTemplateSyncService, useValue: { syncByWabaId } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'PLATFORM_ADMIN_TOKEN' ? CONFIGURED : undefined),
          },
        },
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
    enter.mockReset().mockResolvedValue(TENANT_ID);
    connect.mockReset().mockResolvedValue(CONNECTED);
    syncByWabaId.mockReset().mockResolvedValue(SYNCED);
  });

  describe('POST /api/v1/admin/tenants/{slug}/whatsapp/business-accounts', () => {
    function post(body: object, token: string | null = TOKEN) {
      const call = request(server).post('/api/v1/admin/tenants/acme/whatsapp/business-accounts');

      return (token === null ? call : call.set('authorization', `Bearer ${token}`)).send(body);
    }

    it('refuses a caller with no platform admin token', async () => {
      const response = await post(CONNECT_BODY, null);

      expect(response.status).toBe(401);
      expect(connect).not.toHaveBeenCalled();
    });

    it('enters the named tenant’s scope before touching tenant data', async () => {
      await post(CONNECT_BODY);

      expect(enter).toHaveBeenCalledWith('acme');
    });

    it('answers 201 with the published shape when it connected the account', async () => {
      const response = await post(CONNECT_BODY);

      expect(response.status).toBe(201);
      expect(ConnectedWhatsAppBusinessAccountResponseSchema.parse(response.body)).toMatchObject({
        wabaId: WABA_ID,
        accounts: [{ phoneNumberId: '15550001111' }],
      });
    });

    it('answers 200 when the account was already connected and this updated it', async () => {
      connect.mockResolvedValue({ ...CONNECTED, created: false });

      await expect(post(CONNECT_BODY)).resolves.toMatchObject({ status: 200 });
    });

    it('never echoes the access token back', async () => {
      const response = await post(CONNECT_BODY);

      expect(JSON.stringify(response.body)).not.toContain(ACCESS_TOKEN);
    });

    it.each([
      ['no phone numbers', { ...CONNECT_BODY, phoneNumbers: [] }],
      ['a WABA id that is not a Meta id', { ...CONNECT_BODY, wabaId: 'not-an-id' }],
      [
        'a phone number that is not E.164',
        {
          ...CONNECT_BODY,
          phoneNumbers: [{ phoneNumberId: '15550001111', displayPhoneNumber: '555-0001' }],
        },
      ],
      [
        'the same phone number twice',
        {
          ...CONNECT_BODY,
          phoneNumbers: [
            { phoneNumberId: '15550001111', displayPhoneNumber: '+15550001111' },
            { phoneNumberId: '15550001111', displayPhoneNumber: '+15550002222' },
          ],
        },
      ],
      ['an empty access token', { ...CONNECT_BODY, accessToken: '' }],
    ])('rejects a body with %s', async (_case, body) => {
      const response = await post(body);

      expect(response.status).toBe(400);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(connect).not.toHaveBeenCalled();
    });

    it('answers 404 for a slug that names no tenant', async () => {
      enter.mockRejectedValue(new TenantNotFoundError('nope'));

      const response = await post(CONNECT_BODY);

      expect(response.status).toBe(404);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
    });

    it('answers 409 when another tenant already holds the WABA', async () => {
      connect.mockRejectedValue(new WhatsAppIdentityTakenError('waba', WABA_ID));

      const response = await post(CONNECT_BODY);

      expect(response.status).toBe(409);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('conflict');
    });

    it('refuses to connect a channel to a tenant that has been deactivated', async () => {
      // The refusal comes from `assert_tenant_active` inside TenantPrisma, so it
      // applies to the admin surface as much as to a session-authenticated one.
      connect.mockRejectedValue(
        new TenantNotActiveError(TENANT_ID, 'create', 'WhatsappBusinessAccount'),
      );

      const response = await post(CONNECT_BODY);

      expect(response.status).toBe(402);
      const { error } = ApiErrorSchema.parse(response.body);

      expect(error.code).toBe('subscription_inactive');
      // TAR-539: the error's own message names `TenantPrisma` and the tenant id.
      expect(error.message).not.toContain('TenantPrisma');
      expect(error.message).not.toContain(TENANT_ID);
    });

    it('reports our own key misconfiguration as a fault, not as operator error', async () => {
      connect.mockRejectedValue(new WhatsAppTokenUndecryptableError(WABA_ID));

      await expect(post(CONNECT_BODY)).resolves.toMatchObject({ status: 500 });
    });
  });

  describe('POST …/business-accounts/{wabaId}/template-sync', () => {
    function post(wabaId = WABA_ID) {
      return request(server)
        .post(`/api/v1/admin/tenants/acme/whatsapp/business-accounts/${wabaId}/template-sync`)
        .set('authorization', `Bearer ${TOKEN}`)
        .send();
    }

    it('answers 200 with the reconciliation counts', async () => {
      const response = await post();

      expect(response.status).toBe(200);
      expect(SyncMessageTemplatesResponseSchema.parse(response.body)).toMatchObject({
        created: 3,
        updated: 1,
        skipped: 0,
        total: 4,
      });
      expect(syncByWabaId).toHaveBeenCalledWith(WABA_ID);
    });

    it('answers 404 for a WABA this tenant has not connected', async () => {
      // Another tenant's WABA reaches here as absent, which is the point.
      syncByWabaId.mockRejectedValue(new WhatsAppBusinessAccountNotFoundError(WABA_ID));

      const response = await post();

      expect(response.status).toBe(404);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
    });

    it("reports a rejected Meta credential as a channel failure, not as the operator's", async () => {
      syncByWabaId.mockRejectedValue(new MetaAuthenticationError(401, null));

      const response = await post();

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('whatsapp_send_failed');
    });

    it('reports Meta throttling as rate limited, so it reads as "later" rather than "no"', async () => {
      syncByWabaId.mockRejectedValue(new MetaRateLimitedError(429, null, 30));

      const response = await post();

      expect(response.status).toBe(429);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('rate_limited');
    });

    it('reports a Meta outage as an upstream failure', async () => {
      syncByWabaId.mockRejectedValue(new MetaUnavailableError(503, null, 'HTTP 503'));

      const response = await post();

      expect(response.status).toBe(502);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('upstream_unavailable');
    });

    it('rejects a WABA id that is not a Meta id', async () => {
      const response = await post('not-an-id');

      expect(response.status).toBe(400);
      expect(syncByWabaId).not.toHaveBeenCalled();
    });
  });
});
