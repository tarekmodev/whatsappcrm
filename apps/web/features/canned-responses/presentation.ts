import { CANNED_RESPONSE_PREVIEW_LENGTH } from './constants';

/**
 * How a saved reply's body reads in a table cell.
 *
 * Its own function rather than a CSS clamp alone, because the two answer
 * different questions. A body runs to 4096 characters and may carry newlines;
 * shipping all of it into the DOM and hiding the overflow puts the whole thing
 * in the accessibility tree, so a screen reader reads four kilobytes of one
 * customer-service reply to somebody scanning a list of names. Cutting the
 * string is what makes the visible text and the announced text the same. The
 * clamp in the module CSS then handles the narrow column, where even 120
 * characters is more than two lines.
 */

export interface BodyPreview {
  readonly text: string;
  /** True when the cut dropped something, so the cell can say so out loud. */
  readonly isTruncated: boolean;
}

export function previewBody(body: string): BodyPreview {
  // Newlines collapse to spaces: a table cell is one paragraph, and a reply
  // whose first line is "Hi there," would otherwise preview as two words.
  const collapsed = body.replace(/\s+/g, ' ').trim();

  if (collapsed.length <= CANNED_RESPONSE_PREVIEW_LENGTH) {
    return { text: collapsed, isTruncated: false };
  }

  // Cut at the last space inside the budget, so the preview ends on a word
  // rather than mid-syllable. A single word longer than the budget has no space
  // to cut at, and is cut where it stands.
  const cut = collapsed.slice(0, CANNED_RESPONSE_PREVIEW_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');

  return {
    text: `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`,
    isTruncated: true,
  };
}
