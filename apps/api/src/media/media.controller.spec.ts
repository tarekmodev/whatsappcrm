import type { Server } from 'node:http';
import { Readable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  MediaObjectResponseSchema,
  MediaUploadResponseSchema,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TenantNotActiveError } from '../prisma/prisma.errors';
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
 * The load-bearing assertion until TAR-35 lands is the first in each block:
 * with no tenant resolved, the route answers 401 and never reaches a service.
 * There is no path from an unauthenticated request to a row or to a byte.
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

describe('media routes', () => {
  let app: INestApplication;
  let server: Server;
  let store: jest.Mock;
  let discardTemporary: jest.Mock;
  let describeMedia: jest.Mock;
  let read: jest.Mock;
  let tenantId: string | null;

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
      ],
    }).compile();

    // Stands in for TAR-35's `AuthGuard`, which is what will eventually put a
    // tenant on the scope the middleware opens. Spied on the prototype rather
    // than swapping the provider, because the middleware and the error filter
    // both need the real service.
    jest
      .spyOn(TenantContextService.prototype, 'tenantId', 'get')
      .mockImplementation(() => tenantId);

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
    tenantId = TENANT_ID;
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
    it('refuses a request with no tenant resolved, without reaching the service', async () => {
      tenantId = null;

      const response = await upload();

      expect(response.status).toBe(401);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
      expect(store).not.toHaveBeenCalled();
    });

    // Multer wrote the part before the handler ran, so the refusal owns a file
    // on disk. Every request is unauthenticated until TAR-35 lands a guard; if
    // this path skipped the `finally`, each one would strand up to MEDIA_MAX_BYTES
    // in the temporary directory with nothing sweeping it.
    it('removes the temporary part when it refuses for no tenant', async () => {
      tenantId = null;

      await upload();

      expect(discardTemporary).toHaveBeenCalledTimes(1);
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
    it('refuses a request with no tenant resolved', async () => {
      tenantId = null;

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
    it('refuses a request with no tenant resolved, without opening the object', async () => {
      tenantId = null;

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

    it('reports a deactivated tenant as forbidden rather than as a fault', async () => {
      read.mockRejectedValueOnce(new TenantNotActiveError(TENANT_ID, 'findUnique', 'MediaObject'));

      const response = await request(server).get(`/api/v1/media/${MEDIA_ID}/content`);

      expect(response.status).toBe(403);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('forbidden');
    });
  });
});
