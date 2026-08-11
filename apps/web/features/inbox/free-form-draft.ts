import type { SendMediaInput, SendTextInput } from '@whatsappcrm/contracts';
import { MEDIA_CAPTION_MAX_LENGTH, MESSAGE_BODY_MAX_LENGTH } from '@/features/inbox/constants';
import type { ComposerAttachmentValue } from '@/features/inbox/media-draft';

/**
 * What the free-form box has, turned into the send it stands for — or the reason
 * it is not one yet.
 *
 * Pure, and separate from the form, for the reason its template sibling is: the
 * two arms of the union differ in more than a field. A message with a file
 * attached is a *media* send whose text becomes a caption with its own shorter
 * ceiling; a message without one is a *text* send. Deciding that in the middle of
 * a submit handler is how a caption ends up validated against the wrong limit.
 */

export type FreeFormProblem =
  'body-required' | 'body-too-long' | 'attachment-uploading' | 'attachment-failed';

export type FreeFormSendBuild =
  | { readonly outcome: 'ready'; readonly input: SendTextInput | SendMediaInput }
  | { readonly outcome: 'incomplete'; readonly problem: FreeFormProblem };

/**
 * How long the text may be, which depends on what it *is*.
 *
 * WhatsApp allows 4096 characters in a message and 1024 in a caption. The
 * control reads this so the ceiling moves the moment a file is attached, rather
 * than letting somebody write 2000 characters and discover the difference on
 * submit.
 */
export function freeFormMaxLength(attachment: ComposerAttachmentValue): number {
  return attachment.status === 'ready' ? MEDIA_CAPTION_MAX_LENGTH : MESSAGE_BODY_MAX_LENGTH;
}

export function buildFreeFormSend(
  body: string,
  attachment: ComposerAttachmentValue,
): FreeFormSendBuild {
  const trimmed = body.trim();

  // An upload in flight is a send that is not ready, and a failed one is an
  // attachment that would be silently dropped from a message the agent believes
  // carries it. Both are refused before the text is even looked at.
  if (attachment.status === 'uploading') {
    return { outcome: 'incomplete', problem: 'attachment-uploading' };
  }

  if (attachment.status === 'failed') {
    return { outcome: 'incomplete', problem: 'attachment-failed' };
  }

  if (attachment.status === 'empty') {
    if (trimmed === '') {
      return { outcome: 'incomplete', problem: 'body-required' };
    }

    if (trimmed.length > MESSAGE_BODY_MAX_LENGTH) {
      return { outcome: 'incomplete', problem: 'body-too-long' };
    }

    return { outcome: 'ready', input: { type: 'text', body: trimmed } };
  }

  if (trimmed.length > MEDIA_CAPTION_MAX_LENGTH) {
    return { outcome: 'incomplete', problem: 'body-too-long' };
  }

  return {
    outcome: 'ready',
    input: {
      type: attachment.kind,
      mediaId: attachment.mediaId,
      // Omitted rather than empty: the contract's caption is optional, and an
      // empty one is a blank line under the customer's picture.
      ...(trimmed === '' ? {} : { caption: trimmed }),
    },
  };
}
