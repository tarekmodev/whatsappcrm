import type { MediaKind } from '@whatsappcrm/contracts';

/**
 * Typed failures of the media pipeline. Mapped to the published error taxonomy
 * by the controller, and to a parked attachment by the download processor — the
 * same condition means different things on the two paths, so the translation
 * belongs at each boundary rather than in the error itself.
 *
 * None of them carries a storage key, a URL or a token: these messages reach a
 * client, and a storage key names the tenant it belongs to.
 */

/** Base class, so a `catch` can tell a pipeline failure from a programming one. */
export abstract class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * WhatsApp accepts no message carrying this media type.
 *
 * Names the type it was given and nothing more. Listing every accepted type in
 * the message would put an eight-line string in an error envelope; the accepted
 * set is published in `WHATSAPP_MEDIA_LIMITS` for a client that wants to check
 * before it uploads.
 */
export class UnsupportedMediaTypeError extends MediaError {
  constructor(readonly mimeType: string) {
    super(`WhatsApp does not accept ${mimeType} in a message.`);
  }
}

/**
 * The declared media type and the bytes disagree.
 *
 * A `.exe` renamed to `.pdf` is the obvious case, but the common one is honest:
 * a browser guessing `application/octet-stream`. Either way the declared type
 * is what the recipient's client would render by, so shipping bytes that are
 * something else is a defect at best.
 */
export class MediaContentMismatchError extends MediaError {
  constructor(
    readonly declared: string,
    readonly detected: string | null,
  ) {
    super(
      `The uploaded bytes are ${detected ?? 'not of a recognised type'}, not ${declared}. ` +
        'Upload the file with its real media type.',
    );
  }
}

/** Over the ceiling `WHATSAPP_MEDIA_LIMITS` publishes for this kind. */
export class MediaTooLargeError extends MediaError {
  constructor(
    readonly kind: MediaKind | null,
    readonly maxBytes: number,
  ) {
    super(
      `${kind === null ? 'This file' : `A ${kind}`} may be at most ` +
        `${Math.floor(maxBytes / 1_024)} KB, which is WhatsApp's own limit.`,
    );
  }
}

/** No file part in the multipart body. */
export class MediaFileMissingError extends MediaError {
  constructor(readonly fieldName: string) {
    super(`Send the file as a multipart form field named \`${fieldName}\`.`);
  }
}

/** The row exists — or does not — but the bytes it names are not in the store. */
export class MediaObjectMissingError extends MediaError {
  constructor(readonly mediaId: string) {
    super(`The stored bytes for media ${mediaId} could not be read.`);
  }
}

/**
 * No such media object for the tenant in scope.
 *
 * Deliberately not "forbidden": another tenant's id and an id that never
 * existed must be indistinguishable, or the endpoint becomes a way to probe
 * what the platform holds (TAR-39, security).
 */
export class MediaNotFoundError extends MediaError {
  constructor(readonly mediaId: string) {
    super(`No media ${mediaId}.`);
  }
}
