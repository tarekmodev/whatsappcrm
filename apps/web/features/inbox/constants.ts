import {
  InternalNoteCreateInputSchema,
  SendMediaInputSchema,
  SendTextInputSchema,
} from '@whatsappcrm/contracts';

/**
 * Page sizes, skeleton counts and contract-derived bounds for the shared inbox
 * (TAR-71).
 *
 * Here rather than inline so a list, its skeleton's row count and the query that
 * fills it cannot disagree — a skeleton showing three bubbles for a page of
 * thirty is a layout shift waiting to happen.
 */

/** How many messages the thread opens with. One screenful on a laptop, plus room. */
export const THREAD_PAGE_SIZE = 30;

/**
 * Bubbles in the thread skeleton. Fewer than a page: the skeleton stands in for
 * what is about to be *on screen*, not for what the request returns.
 */
export const THREAD_SKELETON_COUNT = 6;

export const NOTES_PAGE_SIZE = 25;
export const NOTES_SKELETON_COUNT = 3;

/**
 * The note length the API enforces, read off the contract's own schema rather
 * than restated here — so the textarea's `maxLength` and the validator that
 * would refuse the submit cannot drift apart.
 *
 * A missing bound throws at module load rather than defaulting: a guessed
 * ceiling would let a note through to a 422 the agent cannot act on.
 */
export const NOTE_BODY_MAX_LENGTH = requireBound(
  InternalNoteCreateInputSchema.shape.body.maxLength,
  'InternalNoteCreateInputSchema.body.maxLength',
);

/**
 * The two send bounds, read off the contract for the same reason: WhatsApp caps
 * a text message and a media caption at different lengths, and a composer that
 * guessed either would let a reply through to a refusal the agent cannot act on.
 */
export const MESSAGE_BODY_MAX_LENGTH = requireBound(
  SendTextInputSchema.shape.body.maxLength,
  'SendTextInputSchema.body.maxLength',
);

export const MEDIA_CAPTION_MAX_LENGTH = requireBound(
  SendMediaInputSchema.shape.caption.unwrap().maxLength,
  'SendMediaInputSchema.caption.maxLength',
);

/**
 * How many templates the picker opens with, and how many rows stand in for them.
 *
 * The page size is the contract's ceiling: an agent scans this list for a name
 * they already know, and paging through approved templates twenty-five at a time
 * to find `order_update` is worse than one slightly larger read. The skeleton
 * count is smaller — it stands in for what is about to be on screen, not for
 * what the request returns.
 */
export const TEMPLATE_PAGE_SIZE = 100;
export const TEMPLATE_SKELETON_COUNT = 4;

function requireBound(value: number | null, name: string): number {
  if (value === null) {
    throw new Error(`The contract no longer publishes ${name}; the composer cannot validate.`);
  }

  return value;
}
