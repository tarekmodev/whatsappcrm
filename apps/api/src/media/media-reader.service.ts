import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { MediaKind, MediaSource } from '@whatsappcrm/contracts';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { MediaNotFoundError } from './media.errors';
import { MEDIA_STORAGE, type MediaStorage } from './storage/media-storage.port';

/**
 * The columns a media read needs. Named once so the projection cannot widen by
 * accident — `storage_key` in particular is an internal locator and has no
 * business in a response.
 */
const MEDIA_OBJECT_PROJECTION = {
  id: true,
  kind: true,
  source: true,
  storageKey: true,
  mimeType: true,
  sizeBytes: true,
  fileName: true,
  createdAt: true,
} as const;

export interface MediaObjectRecord {
  readonly id: string;
  readonly kind: MediaKind;
  readonly source: MediaSource;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileName: string | null;
  readonly createdAt: Date;
}

/** A media object and its bytes, ready to be piped into a response. */
export interface MediaObjectContent {
  readonly media: MediaObjectRecord;
  readonly body: Readable;
}

/**
 * The row, which carries one field the record does not: the storage key is an
 * internal locator, and keeping it off `MediaObjectRecord` is what stops it
 * reaching a response by being spread into one.
 */
interface StoredMediaRow extends MediaObjectRecord {
  readonly storageKey: string;
}

/**
 * Reading one stored media object.
 *
 * ## This is the tenant boundary for media
 *
 * Every read starts from a `TenantPrisma` lookup by id, so RLS supplies
 * `tenant_id` and another tenant's media object is indistinguishable from one
 * that does not exist — which is what `MediaNotFoundError` says, and why it
 * does not say "forbidden": a 403 would confirm the id exists (TAR-39,
 * security).
 *
 * The storage key is then read from **the row**, never from the request. That
 * is the property that makes cross-tenant access impossible rather than merely
 * checked: a caller cannot name a location, only an id, and the only ids that
 * resolve are their own tenant's. Path traversal has nothing to traverse from.
 *
 * ## Streaming
 *
 * `getStream` hands back the object without buffering it. A 100 MB document
 * downloaded by four agents at once is four streams, not four heap allocations.
 */
@Injectable()
export class MediaReaderService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  /** Metadata only — no object-store round trip. */
  async describe(mediaId: string): Promise<MediaObjectRecord> {
    return toRecord(await this.load(mediaId));
  }

  /** Metadata plus the bytes. */
  async read(mediaId: string): Promise<MediaObjectContent> {
    const row = await this.load(mediaId);

    return { media: toRecord(row), body: await this.storage.getStream(row.storageKey) };
  }

  private async load(mediaId: string): Promise<StoredMediaRow> {
    const media = await this.prisma.mediaObject.findUnique({
      where: { id: mediaId },
      select: MEDIA_OBJECT_PROJECTION,
    });

    if (media === null) {
      throw new MediaNotFoundError(mediaId);
    }

    return media;
  }
}

/**
 * Row → record, field by field rather than by rest-spread. Explicit so a column
 * added to the projection cannot arrive in a response by being everything that
 * was not named.
 */
function toRecord(row: StoredMediaRow): MediaObjectRecord {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    fileName: row.fileName,
    createdAt: row.createdAt,
  };
}
