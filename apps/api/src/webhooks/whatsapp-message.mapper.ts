import { PhoneE164Schema, type MessageStatus } from '@whatsappcrm/contracts';
import { MediaKind, MessageContentType } from '../generated/prisma/enums';
import type { WhatsAppInboundMessage } from './whatsapp-payload.schema';

/**
 * The statuses a **status webhook** can report, which is the published ladder in
 * `@whatsappcrm/contracts` and not the wider database enum.
 *
 * The database also has `received`, the terminal state of an *inbound* message.
 * Keeping that out of this type is what lets `isMessageStatusAdvance` be applied
 * directly to whatever this mapper returns: the compiler, rather than a comment,
 * is what stops a status webhook advancing a message that was never on the
 * ladder.
 */
export type ProviderReportedStatus = MessageStatus;

/**
 * Meta's vocabulary translated into the schema's, in one place.
 *
 * Kept out of the writer so the two concerns stay separately testable: what a
 * payload *means* is a table, and what the database *does* about it is a
 * transaction. Every function here is total — Meta adds values without warning,
 * and a mapper that threw on one would fail a whole batch of real customer
 * messages over a type the product simply does not render yet.
 */

/**
 * Meta's `type` → the stored content type. Anything absent is recorded as
 * `unsupported`: TAR-39's rule is that we record what we do not model rather
 * than drop it, and the raw payload stays on `webhook_events` either way.
 *
 * `template` has no entry because it never arrives inbound — it is a property of
 * something *we* sent.
 */
const CONTENT_TYPES: Readonly<Record<string, MessageContentType>> = {
  text: MessageContentType.text,
  image: MessageContentType.image,
  video: MessageContentType.video,
  audio: MessageContentType.audio,
  document: MessageContentType.document,
  sticker: MessageContentType.sticker,
  location: MessageContentType.location,
  contacts: MessageContentType.contacts,
  interactive: MessageContentType.interactive,
  system: MessageContentType.system,
};

/**
 * Meta's status → the stored status. `undefined` means "a value this product
 * does not model" — `deleted` is the live example — and the caller skips it
 * rather than guessing, because guessing here would move a message along a
 * ladder it was never on.
 */
const STATUSES: Readonly<Record<string, ProviderReportedStatus>> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

export function toContentType(metaType: string): MessageContentType {
  return CONTENT_TYPES[metaType] ?? MessageContentType.unsupported;
}

export function toMessageStatus(metaStatus: string): ProviderReportedStatus | undefined {
  return STATUSES[metaStatus];
}

/**
 * The text worth showing in the inbox, or `null` when the type carries none.
 *
 * Captions count: an image with a caption reads as a message with a picture, and
 * dropping the caption loses what the customer actually said.
 */
export function toMessageBody(message: WhatsAppInboundMessage): string | null {
  const candidate =
    message.text?.body ??
    message.image?.caption ??
    message.video?.caption ??
    message.audio?.caption ??
    message.document?.caption ??
    message.button?.text ??
    message.interactive?.button_reply?.title ??
    message.interactive?.list_reply?.title ??
    message.reaction?.emoji;

  return candidate === undefined || candidate.length === 0 ? null : candidate;
}

/**
 * Meta's `wa_id` → E.164, which is the contact dedupe key.
 *
 * Meta sends the number without the leading `+`. Normalising here rather than at
 * the database is the difference between one contact and two for the same
 * person, so the result is validated rather than assumed: a `wa_id` that does
 * not become a valid E.164 number returns `null` and the caller parks the event,
 * instead of creating a contact nothing will ever match again.
 */
export function toPhoneE164(waId: string): string | null {
  const candidate = waId.startsWith('+') ? waId : `+${waId}`;

  return PhoneE164Schema.safeParse(candidate).success ? candidate : null;
}

/**
 * Meta's media-carrying message types, mapped onto `MediaKind`.
 *
 * Only these five. A `text` or `location` message has no bytes to fetch, and a
 * type Meta ships tomorrow arrives as `unsupported` with no media sub-object,
 * so `toInboundMedia` returns `null` for it rather than guessing at a shape.
 */
const MEDIA_KINDS_BY_TYPE: Readonly<Record<string, MediaKind>> = {
  image: MediaKind.image,
  video: MediaKind.video,
  audio: MediaKind.audio,
  document: MediaKind.document,
  sticker: MediaKind.sticker,
};

/** What Meta says about one inbound media object, before anything is fetched. */
export interface InboundMediaDescriptor {
  readonly kind: MediaKind;
  /** Meta's handle. The only thing that can retrieve the bytes, and it expires. */
  readonly providerMediaId: string;
  readonly mimeType: string;
  readonly fileName: string | null;
}

/**
 * The media a message carries, or `null` when it carries none.
 *
 * ## Why `id` is required and everything else is not
 *
 * The handle is what a download is made with; without it there is nothing to
 * fetch and recording an attachment would create a row permanently stuck
 * `pending`. Meta has always sent one for a media message, so its absence means
 * a shape this mapper does not understand — and the message itself is still
 * stored, which is the point of being total here.
 *
 * `mime_type` is defaulted rather than required. Meta usually sends it, and the
 * media endpoint gives the authoritative answer anyway when the download runs;
 * `application/octet-stream` is the honest placeholder in between, and it is
 * the right thing to serve if the download never completes.
 *
 * A caption is deliberately not here — it is the message body, and
 * `toMessageBody` already reads it.
 */
export function toInboundMedia(message: WhatsAppInboundMessage): InboundMediaDescriptor | null {
  const kind = MEDIA_KINDS_BY_TYPE[message.type];

  if (kind === undefined) {
    return null;
  }

  const media =
    message.image ?? message.video ?? message.audio ?? message.document ?? message.sticker;

  if (media?.id === undefined || media.id.length === 0) {
    return null;
  }

  return {
    kind,
    providerMediaId: media.id,
    mimeType:
      media.mime_type === undefined || media.mime_type.length === 0
        ? 'application/octet-stream'
        : media.mime_type,
    fileName: media.filename ?? null,
  };
}

/** Meta's failure detail, flattened to the two columns `messages` has for it. */
export function toFailureReason(
  errors: readonly { code?: string | number; title?: string }[] | undefined,
): { errorCode: string | null; errorMessage: string | null } {
  const first = errors?.[0];

  return {
    errorCode: first?.code === undefined ? null : String(first.code),
    errorMessage: first?.title ?? null,
  };
}
