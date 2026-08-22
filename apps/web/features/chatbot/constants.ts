/**
 * How many knowledge base entries one page of the table holds.
 *
 * The table's skeleton draws exactly this many rows, so the swap from loading to
 * loaded does not change the card's height. Ten rather than the contract's
 * default 25: a tenant's knowledge base is an FAQ and a policy set — tens of
 * documents, not thousands — and a ten-row skeleton reserves a box somebody can
 * see the bottom of.
 */
export const KNOWLEDGE_DOCUMENTS_PAGE_SIZE = 10;

/**
 * How tall the entry editor's text area is, in rows.
 *
 * Shared with its skeleton rather than typed into both: the blank lines that
 * become chunk boundaries have to be visible while the entry is being written,
 * and a placeholder of a different height would move the dialog under the
 * cursor when the real field arrives.
 */
export const ENTRY_CONTENT_ROWS = 10;

/**
 * The bounds and the granularity of the confidence slider.
 *
 * The range mirrors `AiConfigResponseSchema.minConfidence`, which is
 * `z.number().min(0).max(1)` — named here rather than typed into the control so
 * the slider cannot offer a value the schema refuses.
 *
 * The step is the console's alone: nothing on the server cares whether a
 * threshold is 0.60 or 0.6173, but an admin reading "62%" back cannot tell
 * whether somebody chose it or a drag produced it. Five points is the coarsest
 * granularity that still lets the threshold be tuned.
 */
export const MIN_CONFIDENCE_RANGE = {
  min: 0,
  max: 1,
  step: 0.05,
} as const;
