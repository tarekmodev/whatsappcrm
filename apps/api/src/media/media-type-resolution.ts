import {
  UPLOADABLE_MEDIA_KINDS,
  WHATSAPP_MEDIA_LIMITS,
  mediaKindForMimeType,
  normaliseMimeType,
  type MediaKind,
  type UploadableMediaKind,
} from '@whatsappcrm/contracts';
import { isContentConsistentWithDeclaredType, sniffContentType } from './content-type-sniffer';
import {
  MediaContentMismatchError,
  MediaTooLargeError,
  UnsupportedMediaTypeError,
} from './media.errors';

/** What an upload turned out to be, once the declaration and the bytes agree. */
export interface ResolvedMediaType {
  readonly kind: UploadableMediaKind;
  /** The type the object is stored and sent under — not necessarily the declared one. */
  readonly mimeType: string;
}

/**
 * Decides what an uploaded file actually is, and refuses it if the answer is
 * "not something WhatsApp carries".
 *
 * ## The rule, and why it is two branches rather than one
 *
 * A declared media type is attacker-controlled, so it is never the last word.
 * But it is also the only thing that can distinguish a `.docx` from a `.xlsx`
 * — both are ZIP archives — so it cannot simply be discarded either. Hence:
 *
 *   1. **The declaration names a type WhatsApp accepts.** Then it is used, but
 *      only after the bytes are checked against it. A JPEG declared as a PDF is
 *      refused: the declaration is what the recipient's client renders by, and
 *      shipping a mislabelled file is a defect whoever caused it.
 *   2. **It does not.** Then the bytes decide. This is not a loophole — using
 *      the *detected* type is strictly safer than trusting a declaration — and
 *      it is the common case in practice: a browser that cannot guess sends
 *      `application/octet-stream`, and refusing those would make the endpoint
 *      unusable from a plain file input.
 *
 * If neither branch produces an accepted type, the upload is refused with the
 * type it declared, because that is the thing the caller can act on.
 *
 * ## Size is checked against the resolved kind, not the declared one
 *
 * Deliberately, and it is the whole reason resolution comes first. Meta's
 * document ceiling is twenty times its image ceiling; a 90 MB video declared as
 * a document would sail through a check made before the kind was known.
 */
export function resolveUploadedMediaType(
  declaredMimeType: string,
  head: Buffer,
): ResolvedMediaType {
  const declared = normaliseMimeType(declaredMimeType);
  const declaredKind = mediaKindForMimeType(declared);

  if (declaredKind !== null) {
    if (!isContentConsistentWithDeclaredType(head, declared)) {
      throw new MediaContentMismatchError(declared, sniffContentType(head));
    }

    return { kind: requireUploadable(declaredKind, declared), mimeType: declared };
  }

  const detected = sniffContentType(head);
  const detectedKind = detected === null ? null : mediaKindForMimeType(detected);

  if (detected === null || detectedKind === null) {
    throw new UnsupportedMediaTypeError(declared);
  }

  return { kind: requireUploadable(detectedKind, declared), mimeType: detected };
}

/**
 * Refuses a size over the ceiling `WHATSAPP_MEDIA_LIMITS` publishes for `kind`.
 *
 * Called on both paths — the upload, where the size is already known, and the
 * inbound download, where it is discovered as the bytes arrive — so the two can
 * never drift to different numbers.
 */
export function assertWithinMediaLimit(kind: MediaKind, sizeBytes: number): void {
  const { maxBytes } = WHATSAPP_MEDIA_LIMITS[kind];

  if (sizeBytes > maxBytes) {
    throw new MediaTooLargeError(kind, maxBytes);
  }
}

/**
 * `sticker` is the one kind this platform stores but does not accept as an
 * upload — sending one needs a sticker pack registered with Meta, which the
 * product does not model. Refusing it here rather than returning a `mediaId`
 * that no send can use is the difference between an error and a dead end.
 *
 * Reported against the *declared* type, which is what the caller sent and can
 * do something about.
 */
function requireUploadable(kind: MediaKind, declared: string): UploadableMediaKind {
  const uploadable = UPLOADABLE_MEDIA_KINDS.find((candidate) => candidate === kind);

  if (uploadable === undefined) {
    throw new UnsupportedMediaTypeError(declared);
  }

  return uploadable;
}
