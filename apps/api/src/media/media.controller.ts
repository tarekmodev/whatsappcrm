import { pipeline } from 'node:stream/promises';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  mediaContentPath,
  type MediaObjectResponse,
  type MediaUploadResponse,
} from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { contentDispositionFor } from './media-file-name';
import { MEDIA_UPLOAD_FIELD } from './media.constants';
import {
  MediaContentMismatchError,
  MediaFileMissingError,
  MediaNotFoundError,
  MediaObjectMissingError,
  MediaTooLargeError,
  UnsupportedMediaTypeError,
} from './media.errors';
import { MediaReaderService, type MediaObjectRecord } from './media-reader.service';
import { MediaUploadService, type UploadedMediaFile } from './media-upload.service';

/**
 * Multer's file object, narrowed to what this controller reads.
 *
 * Declared rather than imported: `@nestjs/platform-express` bundles multer but
 * publishes no `File` type, and `@types/multer` would be a dependency added to
 * name five properties. Everything below is a field multer has set on this
 * object since v1.
 */
interface MulterFile {
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
}

/**
 * `POST /api/v1/media` and the reads that go with it (TAR-20e).
 *
 * ## The three routes
 *
 *   * `POST   /api/v1/media`              → `{ mediaId }`, multipart. In 0002's
 *     endpoint list since TAR-39.
 *   * `GET    /api/v1/media/{id}`         → `MediaObjectResponse`. Metadata, so
 *     the composer can show "invoice.pdf, 240 KB" after an upload without
 *     downloading the file back.
 *   * `GET    /api/v1/media/{id}/content` → the bytes.
 *
 * The two reads are **added by this story** rather than taken from 0002, under
 * the same conventions amendment 1 used for `GET /api/v1/message-templates`:
 * a media object that can be created and never read is not a feature, and
 * `MessageAttachmentSchema.url` has published a re-hosted URL since TAR-39
 * without anything serving one. Recorded as amendment 3 in
 * `docs/architecture/0002-architecture-and-api-contract.md`.
 *
 * ## Authentication and permission — read this before adding a fourth route
 *
 * The published pipeline puts `AuthGuard` (TAR-35) and `PermissionGuard`
 * (TAR-22) in front of every tenant-facing route, and **neither exists yet**.
 * Until they do, every handler here refuses a request with no tenant in scope,
 * which today is all of them: the tenant-context middleware opens the scope
 * with `tenantId: null` and nothing fills it in. This is the same deliberate
 * fail-closed placeholder `MessageTemplatesController` documents, and it gives
 * the same guarantee and no more — no code path from an unauthenticated request
 * to a row, but no enforcement of `conversation:send`, which is the permission
 * these routes get when TAR-22 lands.
 *
 * ## Why the content route is authenticated rather than a signed URL
 *
 * A signed URL would let the inbox fetch media without a session and would take
 * the bytes off this process. It is the better answer once there is an object
 * store to sign against — and it is the wrong answer to reach for first, because
 * a signing scheme with no place to store keys, no revocation and no expiry
 * policy is a cross-tenant leak with a nicer interface. The session is the
 * authority today; `MediaStorage` is where a signed-URL adapter attaches later.
 */
@Controller({ path: 'media', version: '1' })
@UseFilters(ApiExceptionFilter)
export class MediaController {
  constructor(
    private readonly uploads: MediaUploadService,
    private readonly reader: MediaReaderService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The multipart upload.
   *
   * Multer has already written the part to disk by the time this runs, under
   * the module-level options in `media.module.ts` — one file, at most
   * `MEDIA_MAX_BYTES`, straight to a temporary directory. Buffering it in
   * memory instead would make a handful of concurrent 100 MB documents an
   * out-of-memory kill.
   *
   * The temporary file is removed in a `finally`, on every path including the
   * validation failures, which are the common ones.
   *
   * The `try` opens before the tenant check, not after, because multer has
   * already written the part by then: a rejected request has a file on disk
   * exactly like an accepted one. Refusing above the `finally` would leak that
   * file on every unauthenticated call — which today is all of them, until
   * TAR-35 puts a guard in front. The guard against `undefined` in the `finally`
   * is for the no-part request, where there is nothing to remove.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor(MEDIA_UPLOAD_FIELD))
  async upload(@UploadedFile() file: MulterFile | undefined): Promise<MediaUploadResponse> {
    try {
      this.requireTenant();

      if (file === undefined) {
        translateFailure(new MediaFileMissingError(MEDIA_UPLOAD_FIELD));
      }

      const stored = await this.uploads
        .store(toUploadedMediaFile(file))
        .catch((error: unknown) => translateFailure(error));

      return { mediaId: stored.id };
    } finally {
      if (file !== undefined) {
        await this.uploads.discardTemporary(file.path);
      }
    }
  }

  @Get(':id')
  async describe(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: invalidId })) id: string,
  ): Promise<MediaObjectResponse> {
    this.requireTenant();

    const media = await this.reader.describe(id).catch((error: unknown) => translateFailure(error));

    return toResponse(media);
  }

  /**
   * Streams the bytes.
   *
   * `@Res()` rather than a `StreamableFile`, because the headers are the point
   * here and they have to be set before the first byte goes out. Piping by hand
   * also means a mid-stream failure destroys the response instead of leaving a
   * truncated body that looks complete to the client.
   *
   * The headers, and why each one is there:
   *
   *   * `Content-Type` from the row, never sniffed by the browser;
   *   * `X-Content-Type-Options: nosniff`, so a browser cannot decide the file
   *     is HTML and run it on this origin;
   *   * `Content-Disposition: attachment`, same reason, plus the file name;
   *   * `Content-Length`, so a truncated transfer is detectable;
   *   * `Cache-Control: private, no-store`. Tenant data must not sit in a shared
   *     cache, and this response is authorised by a session that can be revoked.
   */
  @Get(':id/content')
  async content(
    @Param('id', new ParseUUIDPipe({ exceptionFactory: invalidId })) id: string,
    @Res() response: Response,
  ): Promise<void> {
    this.requireTenant();

    const { media, body } = await this.reader
      .read(id)
      .catch((error: unknown) => translateFailure(error));

    response.setHeader('content-type', media.mimeType);
    response.setHeader('content-length', media.sizeBytes);
    response.setHeader('content-disposition', contentDispositionFor(media.fileName));
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'private, no-store');

    await pipeline(body, response);
  }

  /** Stands in for `AuthGuard` until TAR-35 lands. See the class comment. */
  private requireTenant(): void {
    if (this.tenantContext.tenantId === null) {
      throw new ApiException(
        'unauthenticated',
        'This endpoint requires an authenticated tenant session.',
      );
    }
  }
}

/**
 * Multer's naming into this codebase's. The one place the two spellings meet,
 * so nothing below the controller has to know what multer calls things.
 */
function toUploadedMediaFile(file: MulterFile): UploadedMediaFile {
  return {
    path: file.path,
    originalName: file.originalname,
    declaredMimeType: file.mimetype,
    sizeBytes: file.size,
  };
}

/**
 * Media failures as the published error taxonomy states them.
 *
 * The mapping is the interesting part:
 *
 *   * an unsupported type and a mislabelled one are `validation_failed` (400)
 *     with a `details` entry naming the field, because both are things the
 *     caller can fix by uploading a different file;
 *   * over the limit is `payload_too_large` (413), which the taxonomy has for
 *     exactly this and which a client can branch on without parsing prose;
 *   * an unknown id is `not_found` — never `forbidden`, which would confirm the
 *     id exists in another tenant (TAR-39, security);
 *   * bytes the store cannot produce for a row that exists is `internal_error`.
 *     It means the database and the object store disagree, which is an
 *     operational fault and not the caller's problem.
 */
function translateFailure(error: unknown): never {
  if (error instanceof MediaFileMissingError) {
    throw new ApiException('validation_failed', error.message, [
      { path: error.fieldName, message: error.message },
    ]);
  }

  if (error instanceof UnsupportedMediaTypeError || error instanceof MediaContentMismatchError) {
    throw new ApiException('validation_failed', error.message, [
      { path: MEDIA_UPLOAD_FIELD, message: error.message },
    ]);
  }

  if (error instanceof MediaTooLargeError) {
    throw new ApiException('payload_too_large', error.message);
  }

  if (error instanceof MediaNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof MediaObjectMissingError) {
    // The row is there and the bytes are not: a restore that brought back the
    // database without the volume, or a manual deletion. The caller is told
    // nothing beyond "server fault"; the detail is already in the log.
    throw new ApiException(
      'internal_error',
      'The stored media could not be read. This has been logged.',
    );
  }

  if (error instanceof TenantNotActiveError) {
    // A deactivated tenant with a session still open (TAR-51). A runtime state
    // an operator created, not a fault — reporting it as 500 would page someone
    // every time a tenant was shut off. TAR-41's global filter takes this over.
    throw new ApiException('forbidden', error.message);
  }

  throw error;
}

/** A path parameter that is not a UUID names nothing, and says so as a 400. */
function invalidId(): ApiException {
  return new ApiException('validation_failed', 'The media id must be a UUID.', [
    { path: 'id', message: 'Must be a UUID.' },
  ]);
}

/**
 * Row → response. Explicit rather than a spread, so widening the projection
 * cannot quietly widen the API — `storage_key` and `checksum_sha256` are
 * internal, and neither is published.
 */
function toResponse(media: MediaObjectRecord): MediaObjectResponse {
  return {
    id: media.id,
    kind: media.kind,
    source: media.source,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    fileName: media.fileName,
    contentPath: mediaContentPath(media.id),
    createdAt: media.createdAt.toISOString(),
  };
}
