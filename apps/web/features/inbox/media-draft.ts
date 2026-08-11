import {
  UPLOADABLE_MEDIA_KINDS,
  WHATSAPP_MEDIA_LIMITS,
  mediaKindForMimeType,
  type UploadableMediaKind,
} from '@whatsappcrm/contracts';

/**
 * Whether a file the agent just picked is one WhatsApp will carry — decided in
 * the browser, before the upload is spent.
 *
 * The limits are the contract's, not a copy of them: `media.ts` publishes Meta's
 * per-kind ceilings and media types precisely so the composer can refuse a 40 MB
 * photo without a round trip. The API applies the same rules again and Meta a
 * third time; this exists so the agent learns in the moment rather than after
 * watching an upload bar fill.
 */

/**
 * A file the agent picked, at whatever stage it has reached.
 *
 * Here rather than beside the control that renders it, because it is draft
 * state: the send builder reads it to decide whether there is a message to send,
 * and a pure module has no business importing a component's types.
 */
export type ComposerAttachmentValue =
  | { readonly status: 'empty' }
  | { readonly status: 'uploading'; readonly fileName: string }
  /** Uploaded; `mediaId` is what `SendMediaInput` and a media header name. */
  | {
      readonly status: 'ready';
      readonly mediaId: string;
      readonly fileName: string;
      readonly kind: UploadableMediaKind;
    }
  | { readonly status: 'failed'; readonly fileName: string; readonly message: string };

export const EMPTY_ATTACHMENT: ComposerAttachmentValue = { status: 'empty' };

export type MediaCheck =
  | { readonly outcome: 'accepted'; readonly kind: UploadableMediaKind }
  /** WhatsApp carries no message with this media type — or not in this slot. */
  | { readonly outcome: 'unsupported-type' }
  | {
      readonly outcome: 'too-large';
      readonly kind: UploadableMediaKind;
      readonly maxBytes: number;
    };

/** What the picker may accept. Everything uploadable, unless a slot narrows it. */
export const ATTACHABLE_MEDIA_KINDS: readonly UploadableMediaKind[] = UPLOADABLE_MEDIA_KINDS;

export function checkMediaFile(
  file: { readonly type: string; readonly size: number },
  allowedKinds: readonly UploadableMediaKind[],
): MediaCheck {
  const kind = mediaKindForMimeType(file.type);

  // `sticker` is a kind this returns and never one that may be uploaded, so the
  // membership test does both jobs: unknown type, and known type in a slot that
  // does not take it — a template with an IMAGE header offered a PDF.
  if (kind === null || !isAllowed(kind, allowedKinds)) {
    return { outcome: 'unsupported-type' };
  }

  const { maxBytes } = WHATSAPP_MEDIA_LIMITS[kind];

  if (file.size > maxBytes) {
    return { outcome: 'too-large', kind, maxBytes };
  }

  return { outcome: 'accepted', kind };
}

/**
 * The `accept` attribute for a file input restricted to these kinds.
 *
 * A hint the platform picker uses to grey out what cannot be chosen, never a
 * check: `accept` is trivially bypassed by drag-and-drop and by "all files" in
 * most native dialogs, which is why `checkMediaFile` runs on what was picked.
 */
export function mediaAcceptAttribute(allowedKinds: readonly UploadableMediaKind[]): string {
  return allowedKinds.flatMap((kind) => WHATSAPP_MEDIA_LIMITS[kind].mimeTypes).join(',');
}

function isAllowed(
  kind: ReturnType<typeof mediaKindForMimeType>,
  allowedKinds: readonly UploadableMediaKind[],
): kind is UploadableMediaKind {
  return allowedKinds.some((allowed) => allowed === kind);
}
