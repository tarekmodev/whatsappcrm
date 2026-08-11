import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/**
 * Media — the binaries a conversation carries, in both directions (TAR-20e).
 *
 * Two flows meet in one stored object:
 *
 *   * **inbound** — Meta hands us a media *handle* and a URL that expires in
 *     five minutes, so the pipeline downloads the bytes and re-hosts them. The
 *     attachment on the message points at what we stored, never at Meta.
 *   * **outbound** — the composer uploads a file to `POST /api/v1/media`, gets
 *     a `mediaId` back, and names that id in the send that follows.
 *
 * The limits below are **Meta's**, published here rather than hidden in the API
 * so the composer can refuse a 40 MB photo before spending the upload. They are
 * the contract the server enforces, not a hint: a client that skips the check
 * gets the same answer, one round trip later.
 */

/**
 * What kind of thing a stored binary is. This is the WhatsApp vocabulary, not a
 * general-purpose one — `sticker` exists because Meta has a distinct message
 * type for it with its own size ceiling, and lumping it in with `image` would
 * mean accepting a 5 MB "sticker" the Cloud API would reject.
 */
export const MEDIA_KINDS = ['image', 'video', 'audio', 'document', 'sticker'] as const;
export const MediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * The kinds a tenant may upload, which is exactly `SendMediaInputSchema.type`.
 *
 * `sticker` is inbound-only on purpose: sending one requires a sticker pack
 * registered with Meta, which the product does not model, so accepting an upload
 * that could never be sent would be a dead end with a `mediaId` on the end of it.
 */
export const UPLOADABLE_MEDIA_KINDS = ['image', 'video', 'audio', 'document'] as const;
export const UploadableMediaKindSchema = z.enum(UPLOADABLE_MEDIA_KINDS);
export type UploadableMediaKind = (typeof UPLOADABLE_MEDIA_KINDS)[number];

export interface MediaKindLimit {
  /** Meta's ceiling for this kind, in bytes. */
  readonly maxBytes: number;
  /** Exactly the media types the Cloud API accepts for this kind. */
  readonly mimeTypes: readonly string[];
}

const MEGABYTE = 1_024 * 1_024;

/**
 * Meta's own media constraints, per kind.
 *
 * An allow-list rather than a deny-list, and per kind rather than one global
 * set, because both halves matter: `image/gif` is a type WhatsApp does not
 * accept at all, and `image/webp` is one it accepts only as a sticker. A single
 * flat list of "media types" would let both through and turn a rejection we can
 * explain into a provider error we cannot.
 *
 * Sizes are the Cloud API's published limits. They are ceilings, not targets —
 * the API enforces them so a caller learns before the upload is spent, and Meta
 * enforces them again on the way out.
 */
export const WHATSAPP_MEDIA_LIMITS: Readonly<Record<MediaKind, MediaKindLimit>> = {
  image: {
    maxBytes: 5 * MEGABYTE,
    mimeTypes: ['image/jpeg', 'image/png'],
  },
  video: {
    maxBytes: 16 * MEGABYTE,
    // `video/3gpp` is the registered type; Meta documents the format as "3gp".
    mimeTypes: ['video/mp4', 'video/3gpp'],
  },
  audio: {
    maxBytes: 16 * MEGABYTE,
    mimeTypes: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
  },
  document: {
    maxBytes: 100 * MEGABYTE,
    mimeTypes: [
      'application/pdf',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  },
  sticker: {
    // Meta's animated-sticker ceiling. The 100 KB static limit is not enforced
    // separately: telling the two apart means parsing the WebP container, and
    // the only sticker this product stores is one Meta already accepted inbound.
    maxBytes: 500 * 1_024,
    mimeTypes: ['image/webp'],
  },
};

/**
 * The largest upload any kind permits, which is what a transport-level cap has
 * to be set to. Derived rather than written down, so raising a per-kind limit
 * cannot leave the body-size guard behind at the old number.
 */
export const MEDIA_MAX_BYTES = Math.max(
  ...MEDIA_KINDS.map((kind) => WHATSAPP_MEDIA_LIMITS[kind].maxBytes),
);

/**
 * The kind a media type belongs to, or `null` when WhatsApp accepts no message
 * carrying it.
 *
 * Media types are matched case-insensitively and without their parameters:
 * `Text/Plain; charset=utf-8` is `text/plain`, and a browser that sends the
 * charset should not be told its file is unsupported.
 */
export function mediaKindForMimeType(mimeType: string): MediaKind | null {
  const normalised = normaliseMimeType(mimeType);

  return (
    MEDIA_KINDS.find((kind) => WHATSAPP_MEDIA_LIMITS[kind].mimeTypes.includes(normalised)) ?? null
  );
}

/** Lower-cased, parameters stripped, whitespace trimmed. */
export function normaliseMimeType(mimeType: string): string {
  // `split` on a non-empty separator always yields at least one element, but
  // `noUncheckedIndexedAccess` cannot know that — and `?? mimeType` is a
  // truthful fallback rather than a cast.
  return (mimeType.split(';')[0] ?? mimeType).trim().toLowerCase();
}

/**
 * Where a stored binary came from. It decides retention and what may be done
 * with it, so it is recorded rather than inferred from whether an attachment
 * happens to reference it.
 */
export const MEDIA_SOURCES = ['inbound', 'upload'] as const;
export const MediaSourceSchema = z.enum(MEDIA_SOURCES);
export type MediaSource = (typeof MEDIA_SOURCES)[number];

/**
 * How far an inbound attachment has got.
 *
 * Published because the inbox has to render the difference. Downloading happens
 * off the ingest path — Meta's media endpoint is a second network call and a
 * 100 MB document is not something to hold a webhook open for — so there is a
 * real interval in which the message exists and its picture does not.
 *
 *   * `pending` — the message is recorded, the bytes are still being fetched.
 *   * `stored`  — re-hosted; `url` is populated and will not expire.
 *   * `failed`  — Meta refused, the handle expired, or the payload broke a
 *     limit. Terminal, and the reason is on the row. The message stays in the
 *     thread: the customer did send something, and a gap would say otherwise.
 *
 * An outbound attachment is `stored` from the moment it exists — the bytes were
 * uploaded before the message was sent.
 */
export const MEDIA_DOWNLOAD_STATES = ['pending', 'stored', 'failed'] as const;
export const MediaDownloadStateSchema = z.enum(MEDIA_DOWNLOAD_STATES);
export type MediaDownloadState = (typeof MEDIA_DOWNLOAD_STATES)[number];

/**
 * The multipart field `POST /api/v1/media` reads the file from.
 *
 * Published rather than kept in the API, because it is half of a wire contract
 * whose other half is the composer's `FormData`: a field name the two disagree
 * on is an upload that arrives with no file at all, and the answer is a
 * `validation_failed` naming a field nobody typed.
 */
export const MEDIA_UPLOAD_FIELD = 'file';

/**
 * What `POST /api/v1/media` returns.
 *
 * Just the id: the caller already knows what it uploaded, and the row carries
 * nothing else it has not just supplied. The id is what
 * `SendMediaInputSchema.mediaId` and `SendTemplateHeaderSchema.mediaId` take.
 */
export const MediaUploadResponseSchema = z.object({
  mediaId: IdSchema,
});

/**
 * One stored binary, as `GET /api/v1/media/{id}` describes it.
 *
 * A metadata read, deliberately separate from `GET /api/v1/media/{id}/content`
 * which streams the bytes. The composer needs to show "invoice.pdf, 240 KB"
 * after an upload without downloading the file back.
 */
export const MediaObjectResponseSchema = z.object({
  id: IdSchema,
  kind: MediaKindSchema,
  source: MediaSourceSchema,
  mimeType: z.string(),
  sizeBytes: z.int().nonnegative(),
  fileName: z.string().nullable(),
  /**
   * Where the bytes are, relative to the API root. Relative rather than
   * absolute because the same row is served through a platform subdomain and
   * through a tenant's own custom domain (TAR-29), and a stored absolute URL
   * would name whichever host happened to be configured when it was written.
   */
  contentPath: z.string(),
  createdAt: TimestampSchema,
});

export type MediaUploadResponse = z.infer<typeof MediaUploadResponseSchema>;
export type MediaObjectResponse = z.infer<typeof MediaObjectResponseSchema>;

/** The one place the content route is spelled, so the API and the web app agree. */
export function mediaContentPath(mediaId: string): string {
  return `/api/v1/media/${mediaId}/content`;
}
