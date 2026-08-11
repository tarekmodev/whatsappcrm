import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { WHATSAPP_MEDIA_LIMITS } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { MediaSource } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { SNIFF_BYTES } from './content-type-sniffer';
import { sanitiseFileName } from './media-file-name';
import { mediaObjectKey } from './media-object-key';
import { resolveUploadedMediaType, assertWithinMediaLimit } from './media-type-resolution';
import { MEDIA_STORAGE, type MediaStorage } from './storage/media-storage.port';

/**
 * One multipart part, as the controller hands it over.
 *
 * Declared here rather than imported from multer's types: the fields below are
 * the only ones this service reads, `@nestjs/platform-express` bundles multer
 * without publishing its `File` type, and depending on `@types/multer` to name
 * four properties would be a dependency for a type.
 */
export interface UploadedMediaFile {
  /** Where multer wrote it. Owned by the caller, which removes it afterwards. */
  readonly path: string;
  readonly originalName: string;
  /** What the client said it was. Never trusted on its own. */
  readonly declaredMimeType: string;
  readonly sizeBytes: number;
}

export interface StoredMediaObject {
  readonly id: string;
}

/**
 * `POST /api/v1/media` — the write half of the outbound path.
 *
 * ## The order of operations, and why it is this one
 *
 * Validate, write bytes, then insert the row. Not the other way round:
 *
 *   * a row inserted before the write can end up pointing at bytes that never
 *     arrived, and an agent discovers that when the send fails;
 *   * bytes written before the row can end up as a stray object with no row,
 *     which costs disk and nothing else, and which the retention sweep
 *     collects.
 *
 * One of those two failures is a customer-visible defect and the other is
 * housekeeping, so the order is chosen to only ever produce the second. On an
 * insert failure the stray is removed immediately anyway — the sweep is the
 * backstop, not the plan.
 *
 * ## Validation happens before a single byte is copied
 *
 * The head of the temporary file is read and checked first, so an unsupported
 * or mislabelled upload costs 32 bytes of I/O rather than a 100 MB copy. The
 * upload itself has already been written to disk by then — that is multer's
 * doing, bounded by `MEDIA_MAX_BYTES`, and it is what makes reading the head
 * possible without buffering the file in memory.
 *
 * ## Isolation
 *
 * The row goes in through `TenantPrisma`, so `tenant_isolation` supplies and
 * enforces `tenant_id`, and the storage key is built from the tenant in scope
 * rather than from anything in the request. There is no code path from a
 * request field to a storage location.
 */
@Injectable()
export class MediaUploadService {
  private readonly logger = new Logger(MediaUploadService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    private readonly tenantContext: TenantContextService,
  ) {}

  async store(file: UploadedMediaFile): Promise<StoredMediaObject> {
    const tenantId = this.tenantContext.requireTenantId();

    const { kind, mimeType } = resolveUploadedMediaType(
      file.declaredMimeType,
      await readHead(file.path),
    );

    // Checked against the resolved kind, before the copy. Multer's own limit is
    // the largest any kind allows, so it lets a 40 MB "image" through — this is
    // where that becomes the error the caller sees, naming the real ceiling.
    assertWithinMediaLimit(kind, file.sizeBytes);

    const key = mediaObjectKey(tenantId, kind, randomUUID());
    const written = await this.storage.putStream(
      key,
      createReadStream(file.path),
      WHATSAPP_MEDIA_LIMITS[kind].maxBytes,
    );

    try {
      const created = await this.prisma.mediaObject.create({
        data: {
          tenantId,
          kind,
          source: MediaSource.upload,
          storageKey: key,
          mimeType,
          // The measured size, not `file.sizeBytes`. They agree today; if they
          // ever stop, the number that describes the stored object is the one
          // that was stored.
          sizeBytes: written.sizeBytes,
          checksumSha256: written.checksumSha256,
          fileName: sanitiseFileName(file.originalName),
          uploadedByUserId: this.tenantContext.userId,
        },
        select: { id: true },
      });

      return { id: created.id };
    } catch (error: unknown) {
      // The bytes are now unreferenced. Removed here rather than left for the
      // sweep, because we know exactly which key it is and we know it is dead.
      await this.storage.delete(key).catch((cleanupFailure: unknown) => {
        this.logger.warn(
          `Could not remove media bytes after a failed insert: ${describe(cleanupFailure)}`,
        );
      });

      throw error;
    }
  }

  /**
   * Removes the temporary file multer wrote.
   *
   * Exposed so the controller can call it in a `finally` — including on the
   * paths where `store` threw, which is most of the interesting ones. Failure
   * is logged, never thrown: a leftover temporary file is a disk-space problem,
   * and replacing a validation error with it would hide the thing the caller
   * needs to know.
   */
  async discardTemporary(path: string): Promise<void> {
    await rm(path, { force: true }).catch((error: unknown) => {
      this.logger.warn(`Could not remove the temporary upload at ${path}: ${describe(error)}`);
    });
  }
}

/**
 * The first bytes of the file, for the signature check.
 *
 * A bounded read on an open handle rather than a stream: the amount is fixed
 * and tiny, and a stream would need its own teardown on every early return
 * below.
 */
async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');

  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);

    // Truncated to what was actually read: a two-byte file must not present as
    // thirty bytes of zeroes, which would match nothing and read as binary.
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
