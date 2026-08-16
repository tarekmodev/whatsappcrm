import { CANNED_RESPONSE_TRIGGER, type CannedResponseResponse } from '@whatsappcrm/contracts';
import { CANNED_RESPONSE_MATCH_LIMIT } from '@/features/inbox/constants';

/**
 * The `/hours` token an agent is part-way through typing, what it matches in the
 * tenant's canned-response library, and what choosing one does to the draft.
 *
 * Pure, and separate from the composer, for the reason `free-form-draft` is: the
 * three steps are the whole of ADR 0011's shortcut mechanism, they are the part
 * with edge cases worth naming — a slash inside a URL, a token mid-sentence, a
 * body inserted between text the agent already wrote — and none of them needs a
 * rendered textarea to be true.
 *
 * Nothing here reads or writes the DOM, and nothing here can fail: a draft with
 * no token matches nothing, and a query that matches nothing returns an empty
 * list. Degradation is the absence of a result, never an error (0011).
 */

export interface ShortcutToken {
  /** Where the trigger character sits in the draft. Insertion replaces from here. */
  readonly start: number;
  /** The token as typed, trigger included — `/hou`. Never contains whitespace. */
  readonly query: string;
}

/**
 * 0011's trigger, built from the contract's own character so the console cannot
 * open its picker on something the API would never store.
 *
 * The `(?:^|\s)` prefix is the load-bearing part: without it `https://acme.com/hours`
 * opens a menu in the middle of a URL. Case-insensitive because an agent may
 * well type `/Hours` — `shortcut` is `citext`, so the database agrees.
 */
const SHORTCUT_TOKEN = new RegExp(
  String.raw`(?:^|\s)(${CANNED_RESPONSE_TRIGGER}[a-z0-9_-]*)$`,
  'i',
);

/**
 * The shortcut token immediately before the caret, or `null` when there is none.
 *
 * Only the text *before* the caret is looked at. An agent editing back into a
 * finished sentence is not typing a shortcut, and matching what follows the
 * caret would open a picker over a token they have already left.
 */
export function shortcutTokenBefore(draft: string, caret: number): ShortcutToken | null {
  const beforeCaret = draft.slice(0, Math.max(0, caret));
  const query = SHORTCUT_TOKEN.exec(beforeCaret)?.[1];

  if (query === undefined) {
    return null;
  }

  return { start: beforeCaret.length - query.length, query };
}

/**
 * The responses a token offers, ranked: shortcut prefixes first, then titles
 * containing the same term, each group by shortcut ascending, capped at
 * {@link CANNED_RESPONSE_MATCH_LIMIT}.
 *
 * Shortcut before title because the shortcut is what was typed — an agent
 * halfway through `/ho` wants `/hours` at the top, not the response titled
 * "Warehouse address" that happens to contain the same two letters. Bodies are
 * not searched at v1 (0011, open question 5).
 *
 * The order does not depend on the order the API returned, so a caller may hand
 * this whatever it holds.
 */
export function matchCannedResponses(
  responses: readonly CannedResponseResponse[],
  query: string,
  limit: number = CANNED_RESPONSE_MATCH_LIMIT,
): readonly CannedResponseResponse[] {
  const shortcutQuery = query.toLowerCase();
  // The trigger is part of the shortcut but never part of a title, so the title
  // search uses the term the agent typed after it. A bare `/` leaves nothing to
  // search for, which is right: every shortcut already matched above it.
  const titleTerm = shortcutQuery.slice(CANNED_RESPONSE_TRIGGER.length);

  const byShortcut = responses.filter((response) =>
    response.shortcut.toLowerCase().startsWith(shortcutQuery),
  );
  const alreadyMatched = new Set(byShortcut.map((response) => response.id));
  const byTitle =
    titleTerm === ''
      ? []
      : responses.filter(
          (response) =>
            !alreadyMatched.has(response.id) && response.title.toLowerCase().includes(titleTerm),
        );

  return [...byShortcutAscending(byShortcut), ...byShortcutAscending(byTitle)].slice(0, limit);
}

export interface DraftInsertion {
  readonly draft: string;
  /** Where the caret lands: the end of what was just inserted. */
  readonly caret: number;
}

/**
 * Replaces the token with the response's body, leaving the rest of the draft
 * exactly as it was.
 *
 * The result is an ordinary editable draft: nothing is cleared, nothing is sent,
 * and the caret sits at the end of the inserted text so the agent can keep
 * typing — TAR-484's "for review before sending" is this function refusing to do
 * anything else.
 *
 * The inserted body can push the draft past WhatsApp's ceiling. That is
 * `buildFreeFormSend`'s to refuse on submit, not this function's to truncate: a
 * silently shortened canned response is worse than one the agent is told to trim.
 */
export function insertCannedResponse(
  draft: string,
  token: ShortcutToken,
  caret: number,
  body: string,
): DraftInsertion {
  const before = draft.slice(0, token.start);
  const after = draft.slice(Math.max(token.start, caret));

  return { draft: `${before}${body}${after}`, caret: before.length + body.length };
}

function byShortcutAscending(
  responses: readonly CannedResponseResponse[],
): readonly CannedResponseResponse[] {
  return [...responses].sort((left, right) => left.shortcut.localeCompare(right.shortcut));
}
