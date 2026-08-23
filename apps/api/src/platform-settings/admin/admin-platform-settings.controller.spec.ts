import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  PlatformSettingHistoryResponseSchema,
  PlatformSettingListResponseSchema,
  PlatformSettingViewSchema,
  type PlatformSettingView,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../../bootstrap';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../../common/tenant-context/tenant-context.module';
import { PlatformAdminGuard } from '../../tenancy/admin/platform-admin.guard';
import {
  PlatformSettingValueInvalidError,
  PlatformSettingsEncryptionUnavailableError,
  UnknownPlatformSettingError,
} from '../platform-settings.errors';
import { PlatformSettingsService } from '../platform-settings.service';
import { AdminPlatformSettingsController } from './admin-platform-settings.controller';

/**
 * The HTTP contract: who may call it, what each outcome answers, and — the case
 * this surface exists to get right — that no route on it can return a secret.
 *
 * The service is stubbed; what it does to the snapshot and the table is
 * `platform-settings.service.spec.ts` and `platform-settings-schema.int-spec.ts`.
 */

/** The secret half of a `PLATFORM_ADMIN_TOKEN` entry — what a caller presents. */
const TOKEN = 'a-platform-admin-token-of-at-least-32-chars';
/** What the environment holds: the same secret, named (TAR-166). */
const CONFIGURED = `ops-alice:${TOKEN}`;

const SECRET_VIEW: PlatformSettingView = {
  key: 'whatsapp.app_secret',
  description: 'The Meta app secret.',
  sensitivity: 'secret',
  source: 'database',
  isSet: true,
  fingerprint: 'a1b2c3d4',
  hint: '4567',
  updatedAt: '2026-08-23T09:00:00.000Z',
  updatedByLabel: 'ops-alice',
};

const PUBLIC_VIEW: PlatformSettingView = {
  key: 'meta.app_id',
  description: 'The Meta app id.',
  sensitivity: 'public',
  source: 'environment',
  isSet: true,
  value: '1234567890123456',
  fingerprint: 'deadbeef',
  hint: null,
  updatedAt: null,
  updatedByLabel: null,
};

describe('the platform-admin settings routes', () => {
  let app: INestApplication;
  let server: Server;
  let describeOne: jest.Mock;
  let describeAll: jest.Mock;
  let set: jest.Mock;
  let clear: jest.Mock;
  let history: jest.Mock;

  beforeAll(async () => {
    describeOne = jest.fn();
    describeAll = jest.fn();
    set = jest.fn();
    clear = jest.fn();
    history = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [AdminPlatformSettingsController],
      providers: [
        PlatformAdminGuard,
        ApiExceptionFilter,
        {
          provide: PlatformSettingsService,
          useValue: { describe: describeOne, describeAll, set, clear, history },
        },
        {
          provide: ConfigService,
          // Keyed rather than a blanket return: `configureApp` reads
          // `WEB_ORIGIN` from the same service and must get its own default.
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
    describeOne.mockReset().mockReturnValue(SECRET_VIEW);
    describeAll.mockReset().mockReturnValue([SECRET_VIEW, PUBLIC_VIEW]);
    set.mockReset().mockResolvedValue(SECRET_VIEW);
    clear.mockReset().mockResolvedValue({ ...SECRET_VIEW, source: 'environment' });
    history.mockReset().mockResolvedValue([]);
  });

  function authed(method: 'get' | 'put' | 'delete', path: string) {
    return request(server)
      [method](`/api/v1/admin/platform-settings${path}`)
      .set('authorization', `Bearer ${TOKEN}`);
  }

  describe('authentication', () => {
    it('refuses a caller with no platform admin token', async () => {
      await request(server).get('/api/v1/admin/platform-settings').expect(401);
    });

    it('refuses a wrong token', async () => {
      await request(server)
        .get('/api/v1/admin/platform-settings')
        .set('authorization', 'Bearer not-the-token')
        .expect(401);
    });

    it.each([
      ['put', '/whatsapp.app_secret'],
      ['delete', '/whatsapp.app_secret'],
      ['get', '/whatsapp.app_secret/history'],
    ] as const)('refuses an unauthenticated %s %s', async (method, path) => {
      // The guard is on the class, so this is a regression test for it staying
      // there rather than for four separate decorators.
      await request(server)[method](`/api/v1/admin/platform-settings${path}`).expect(401);
    });
  });

  describe('reading', () => {
    it('lists every managed key', async () => {
      const response = await authed('get', '').expect(200);

      expect(PlatformSettingListResponseSchema.parse(response.body).settings).toHaveLength(2);
    });

    it('reads one key', async () => {
      const response = await authed('get', '/whatsapp.app_secret').expect(200);

      expect(PlatformSettingViewSchema.parse(response.body)).toEqual(SECRET_VIEW);
      expect(describeOne).toHaveBeenCalledWith('whatsapp.app_secret');
    });

    it('answers 404 for a key that is not managed', async () => {
      describeOne.mockImplementation(() => {
        throw new UnknownPlatformSettingError('database.url');
      });

      const response = await authed('get', '/database.url').expect(404);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
    });

    it('rejects a malformed key before it reaches a lookup', async () => {
      await authed('get', '/NotAKey').expect(400);

      expect(describeOne).not.toHaveBeenCalled();
    });

    it('returns a key history of fingerprints, with no values', async () => {
      history.mockResolvedValue([
        {
          id: '81111111-1111-7111-8111-111111111111',
          key: 'whatsapp.app_secret',
          action: 'set',
          previousFingerprint: null,
          newFingerprint: 'a1b2c3d4',
          actorLabel: 'ops-alice',
          createdAt: '2026-08-23T09:00:00.000Z',
        },
      ]);

      const response = await authed('get', '/whatsapp.app_secret/history').expect(200);

      expect(PlatformSettingHistoryResponseSchema.parse(response.body).changes).toHaveLength(1);
    });
  });

  describe('writing', () => {
    it('stores the value and attributes it to the credential that authenticated', async () => {
      // The label half of the matching `PLATFORM_ADMIN_TOKEN` entry, never the
      // secret half — the same rule `audit_logs.actor_label` follows.
      await authed('put', '/whatsapp.app_secret')
        .send({ value: 'x'.repeat(40) })
        .expect(200);

      expect(set).toHaveBeenCalledWith('whatsapp.app_secret', 'x'.repeat(40), 'ops-alice');
    });

    it('answers 200 rather than 201, because the setting exists either way', async () => {
      // A caller cannot tell — and does not need to tell — whether this write
      // created the row or replaced it.
      await authed('put', '/meta.app_id').send({ value: '1234567890' }).expect(200);
    });

    it('rejects a body with no value', async () => {
      await authed('put', '/meta.app_id').send({}).expect(400);

      expect(set).not.toHaveBeenCalled();
    });

    it('strips an unknown field rather than carrying it into the write', async () => {
      // `ZodValidationPipe` strips rather than rejects, so a client on a newer
      // version keeps working (TAR-39, conventions). What matters here is that
      // the strip is what prevents mass assignment: `sensitivity` is the
      // registry's to decide, and a body that appeared to carry it must not
      // reach the service.
      await authed('put', '/meta.app_id')
        .send({ value: '1234567890', sensitivity: 'public' })
        .expect(200);

      expect(set).toHaveBeenCalledWith('meta.app_id', '1234567890', 'ops-alice');
    });

    it('reports a value the registry rejects as a validation failure', async () => {
      set.mockRejectedValue(
        new PlatformSettingValueInvalidError('whatsapp.app_secret', 'too short'),
      );

      const response = await authed('put', '/whatsapp.app_secret')
        .send({ value: 'nope' })
        .expect(400);

      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
    });

    it('reports a missing encryption key as a fault, naming the variable', async () => {
      // A deployment gap rather than a bad request: the operator did nothing
      // wrong, and this surface is authenticated for the whole platform, so
      // naming the variable leaks nothing.
      set.mockRejectedValue(new PlatformSettingsEncryptionUnavailableError());

      const response = await authed('put', '/meta.app_id')
        .send({ value: '1234567890' })
        .expect(500);

      expect(ApiErrorSchema.parse(response.body).error.message).toContain('SECRETS_ENCRYPTION_KEY');
    });

    it('answers 404 for a key that is not managed', async () => {
      set.mockRejectedValue(new UnknownPlatformSettingError('database.url'));

      await authed('put', '/database.url').send({ value: 'postgres://nope' }).expect(404);
    });
  });

  describe('reverting to the environment', () => {
    it('answers with the state the key is in now, not an empty body', async () => {
      const response = await authed('delete', '/whatsapp.app_secret').expect(200);

      expect(PlatformSettingViewSchema.parse(response.body).source).toBe('environment');
      expect(clear).toHaveBeenCalledWith('whatsapp.app_secret', 'ops-alice');
    });
  });

  describe('what no route returns', () => {
    it('has no reveal route behind which a secret could be read', async () => {
      // Asserted as a route rather than as a comment: adding one would be a
      // deliberate act that fails here first.
      await authed('get', '/whatsapp.app_secret/reveal').expect(404);
    });

    it('never carries a secret plaintext in any response body', async () => {
      const plaintext = 'the-actual-meta-app-secret-value-0123';

      for (const response of [
        await authed('get', ''),
        await authed('get', '/whatsapp.app_secret'),
        await authed('put', '/whatsapp.app_secret').send({ value: plaintext }),
        await authed('delete', '/whatsapp.app_secret'),
      ]) {
        expect(JSON.stringify(response.body)).not.toContain(plaintext);
      }
    });
  });
});
