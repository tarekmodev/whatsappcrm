import type { Server } from 'node:http';
import { Readable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  MediaObjectResponseSchema,
  MediaUploadResponseSchema,
  permissionsForRole,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { ANONYMOUS, PRINCIPAL_SOURCE, resolved } from '../rbac/principal.source';
import {
  MediaNotFoundError,
  MediaObjectMissingError,
  MediaTooLargeError,
  UnsupportedMediaTypeError,
} from './media.errors';
import { MediaController } from './media.controller';
import { MediaReaderService } from './media-reader.service';
import { MediaUploadService } from './media-upload.service';

/**
 * The HTTP contract of the three media routes.
 *
 * The load-bearing assertion is the first in each block: with no session, the
 * route answers 401 and never reaches a service. There is no path from an
 * unauthenticated request to a row or to a byte.
 *
 * It is proved with the **real** `PrincipalGuard` and `PermissionGuard`,
 * registered as `APP_GUARD` the way `RequestPipelineModule` registers them
 * (TAR-58), and a fake principal source in place of the session read. Before
 * that story these routes had no guards at all and stood on a hand-written
 * tenant check. `HostTenantGuard` needs a database, so the middleware below
 * stands in for it — one `setTenant` call, which is all it contributes.
 *
 * The rest is the error mapping — "unsupported" and "too large" are different
 * codes a client branches on — and the headers on the content route, which are
 * what stop a stored file being executed as a page on this origin.
 */

const MEDIA_ID = '70444444-4444-7444-8444-4444444444f1';
const TENANT_ID = '70444444-4444-7444-8444-444444444401';
const CREATED_AT = new Date('2026-08-11T09:00:00.000Z');

const PDF = Buffer.from('%PDF-1.7 an invoice');

const MEDIA = {
  id: MEDIA_ID,
  kind: 'document' as const,
  source: 'upload' as const,
  mimeType: 'application/pdf',
  // The stored size, and therefore the `Content-Length`. It has to match the
  // body the reader hands back, or the client aborts a short response — which
  // is exactly the detection the header is there to provide.
  sizeBytes: PDF.length,
  fileName: 'invoice.pdf',
  createdAt: CREATED_AT,
};

const PRINCIPAL: SessionPrincipal = {
  userId: '70444444-4444-7444-8444-4444444444a1',
  tenantId: TENANT_ID,
  email: 'agent@example.invalid',
  displayName: 'Ada Agent',
  role: 'agent',
  permissions: [...permissionsForRole('agent')],
  teamIds: [],
  sessionId: '70444444-4444-7444-8444-4444444444e1',
  expiresAt: '2036-12-31T23:59:59.000Z',
};

describe('media routes', () => {
  let app: INestApplication;
  let server: Server;
  let store: jest.Mock;
  let discardTemporary: jest.Mock;
  let describeMedia: jest.Mock;
  let read: jest.Mock;
  let signedIn: boolean;

  beforeAll(async () => {
    store = jest.fn();
    discardTemporary = jest.fn();
    describeMedia = jest.fn();
    read = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [MediaController],
      providers: [
        ApiExceptionFilter,
        { provide: MediaUploadService, useValue: { store, discardTemporary } },
        { provide: MediaReaderService, useValue: { describe: describeMedia, read } },
        // Read by `configureApp` for the CORS allow-list; nothing here needs it.
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PRINCIPAL_SOURCE,
          useValue: { resolve: () => Promise.resolve(signedIn ? resolved(PRINCIPAL) : ANONYMOUS) },
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
    signedIn = true;
    store.mockReset().mockResolvedValue({ id: MEDIA_ID });
    discardTemporary.mockReset().mockResolvedValue(undefined);
    describeMedia.mockReset().mockResolvedValue(MEDIA);
    read.mockReset().mockResolvedValue({ media: MEDIA, body: Readable.from(PDF) });
  });

  function upload() {
    return request(server)
      .post('/api/v1/media')
      .attach('file', PDF, { filename: 'invoice.pdf', contentType: 'application/pdf' });
  }

  describe('POST /api/v1/media', () => {
    it('refuses a request with no session, without reaching the service', async () => {
      signedIn = false;

      const response = await upload();

      expect(response.status).toBe(401);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
      expect(store).not.toHaveBeenCalled();
    });

    /**
     * The guard runs before the file interceptor, so an unauthenticated upload
     * never reaches the disk at all — there is nothing to clean up. Worth an
     * assertion rather than a comment: it is the difference between an anonymous
     * caller costing us a refusal and costing us `MEDIA_MAX_BYTES` of temporary
     * storage per attempt.
     */
    it('refuses before multer writes anything', async () => {
      signedIn = false;

      await upload();

      expect(discardTemporary).not.toHaveBeenCalled();
    });

    it('answers with the id the composer names in the send that follows', async () => {
      const response = await upload();

      expect(response.status).toBe(201);
      expect(MediaUploadResponseSchema.parse(response.body)).toEqual({ mediaId: MEDIA_ID });
    });

    it('passes the part through with the name and type the client declared', async () => {
      await upload();

      expect(store).toHaveBeenCalledWith(
        expect.objectContaining({
          originalName: 'invoice.pdf',
          declaredMimeType: 'application/pdf',
        }),
      );
    });

    it('refuses a body with no file part', async () => {
      const response = await request(server).post('/api/v1/media');

      expect(response.status).toBe(400);
      expect(ApiErrorSchema.parse(response.body).error.details?.[0]?.path).toBe('file');
      expect(store).not.toHaveBeenCalled();
      // Nothing was written, so nothing is removed.
      expect(discardTemporary).not.toHaveBeenCalled();
    });

    it('reports an unsupported media type against the field, not as a bare 400', async () => {
      store.mockRejectedValueOnce(new UnsupportedMediaTypeError('image/gif'));

      const response = await upload();

      expect(response.status).toBe(400);

      const { error } = ApiErrorSchema.parse(response.body);

      expect(error.code).toBe('validation_failed');
      expect(error.details?.[0]?.path).toBe('file');
    });

    it('reports an oversize upload with the code a client branches on', async () => {
      store.mockRejectedValueOnce(new MediaTooLargeError('image', 5 * 1_024 * 1_024));

      const response = await upload();

      expect(response.status).toBe(413);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('payload_too_large');
    });

    it('removes the temporary part whatever happened', async () => {
      store.mockRejectedValueOnce(new UnsupportedMediaTypeError('image/gif'));

      await upload();

      expect(discardTemporary).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/v1/media/{id}', () => {
    it('refuses a request with no session', async () => {
      signedIn = false;

      const response = await request(server).get(`/api/v1/media/${MEDIA_ID}`);

      expect(response.status).toBe(401);
      expect(describeMedia).not.toHaveBeenCalled();
    });

    it('publishes the metadata and nothing internal', async () => {
      const response = await request(server).get(`/api/v1/media/${MEDIA_ID}`);

      expect(response.status).toBe(200);
      expect(MediaObjectResponseSchema.parse(response.body)).toEqual({
        id: MEDIA_ID,
        kind: 'document',
        source: 'upload',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
        fileName: 'invoice.pdf',
        contentPath: `/api/v1/media/${MEDIA_ID}/content`,
        createdAt: CREATED_AT.toISOString(),
      });
      // The storage key and the checksum are internal locators, not fields.
      expect(Object.keys(MediaObjectResponseSchema.parse(response.body))).not.toContain(
        'storageKey',
      );
    });

    it('reports another tenant’s media as absent, never as forbidden', async () => {
      // A 403 would confirm the id exists somewhere (TAR-39, security).
      describeMedia.mockRejectedValueOnce(new MediaNotFoundError(MEDIA_ID));

      const response = await request(server).get(`/api/v1/media/${MEDIA_ID}`);

      expect(response.status).toBe(404);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
    });

    it('refuses an id that is not a UUID before reaching the service', async () => {
      const response = await request(server).get('/api/v1/media/not-an-id');

      expect(response.status).toBe(400);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
      expect(describeMedia).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/media/{id}/content', () => {
    it('refuses a request with no session, without opening the object', async () => {
      signedIn = false;

      const response = await request(server).get(`/api/v1/media/${MEDIA_ID}/content`);

      expect(response.status).toBe(401);
      expect(read).not.toHaveBeenCalled();
    });

    it('streams the bytes', async () => {
      const response = await request(server).get(`/api/v1/media/${MEDIA_ID}/content`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-length']).toBe(String(PDF.length));
    });

    it('sets the headers that stop a download being executed as a page', async () => {
      const response = await request(server).get(`/api/v1/media/${MEDIA_ID}/content`);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.headers['content-disposition']).toContain('invoice.pdf');
      // Tenant data must not sit in a shared cache.
      expect(response.headers['cache-control']).toBe('private, no-store');
    });

    it('reports a row whose bytes are gone as a fault, not as a 404', async () => {
      // The database and the object store disagreeing is operational, and
      // "not found" would hide it from whoever has to fix it.
      read.mockRejectedValueOnce(new MediaObjectMissingError(MEDIA_ID));

      const response = await request(server).get(`/api/v1/media/${MEDIA_ID}/content`);

      expect(response.status).toBe(500);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('internal_error');
    });

    it('reports a deactivated tenant as subscription_inactive rather than as a fault', async () => {
      read.mockRejectedValueOnce(new TenantNotActiveError(TENANT_ID, 'findUnique', 'MediaObject'));

      const response = await request(server).get(`/api/v1/media/${MEDIA_ID}/content`);

      expect(response.status).toBe(402);
      const { error } = ApiErrorSchema.parse(response.body);

      expect(error.code).toBe('subscription_inactive');
      // TAR-539: the error's own message names `TenantPrisma` and the tenant id.
      expect(error.message).not.toContain('TenantPrisma');
      expect(error.message).not.toContain(TENANT_ID);
    });
  });
});
