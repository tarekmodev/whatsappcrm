/**
 * Sizes the saved-reply admin surface shares between its table and that table's
 * skeleton, so the two cannot disagree.
 */

/**
 * Rows the table draws while loading.
 *
 * Four, not `CANNED_RESPONSE_LIMITS.perTenant`: the cap is 200 and a workspace
 * that has just been handed the screen holds a handful, so a page of grey rows
 * the data could never fill would be a worse guess than a short one.
 */
export const CANNED_RESPONSES_SKELETON_COUNT = 4;

/**
 * Characters of the body the table shows before cutting it.
 *
 * The body runs to `CANNED_RESPONSE_LIMITS.bodyLength` — 4096 — and a table that
 * rendered all of it would be one row per screen. Cut here rather than with a
 * CSS line clamp alone so the same string is what a screen reader hears; the
 * clamp in the module CSS handles the narrower case where even this is two lines.
 */
export const CANNED_RESPONSE_PREVIEW_LENGTH = 120;

/**
 * Lines the body textarea opens at. Enough for a typical saved reply without
 * scrolling, and short enough that the dialog still fits a phone in landscape —
 * the box grows no further, because the cap is validated rather than made
 * unreachable by the control's height.
 */
export const CANNED_RESPONSE_BODY_ROWS = 6;
