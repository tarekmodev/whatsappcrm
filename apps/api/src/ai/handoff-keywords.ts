/**
 * "Take me to a human" — the cheapest gate in the turn, and the highest-priority
 * one (0010, handoff-keyword matching).
 *
 * The rule is specified in the design rather than left to the implementation,
 * because a rule nobody wrote down becomes three different rules: **NFKC
 * normalised, case-folded, Arabic diacritics and tatweel stripped, then a
 * substring match of any keyword against the normalised message.**
 *
 * ## Why substring rather than whole-word
 *
 * "agent" has to match "agent?" and "…an agent!", and Arabic is not reliably
 * whitespace-token separable for this purpose — a definite article or a
 * conjunction attaches to the word it qualifies, so a whole-word rule would miss
 * exactly the phrasing a customer is most likely to use. The cost is stated
 * rather than hidden: a short keyword can match inside an unrelated word, which
 * is why `AiConfig.handoffKeywords` is tenant-authored and the console is where
 * a bad keyword gets fixed.
 *
 * ## Why normalisation is not optional
 *
 * A customer typing on a phone produces the same word in several forms —
 * presentation-form ligatures, a stray kashida stretching a word for emphasis,
 * vowel marks a keyboard adds. Comparing raw code points would make the feature
 * work for the tenant who authored the keyword and fail for the customer who
 * typed it, which is the worst kind of intermittent.
 *
 * A pure module with no I/O, so the rule is unit-testable without a model, a
 * queue or a database — which is what 0010's phase table asks for.
 */

/**
 * The marks a customer's keyboard adds and a tenant's keyword does not have.
 *
 *   * `\p{Mn}` — every nonspacing mark: the Arabic harakat, the superscript
 *     alef, and the Quranic annotation marks that arrive through copy and paste.
 *     A property escape rather than the four code-point ranges 0010 names,
 *     because those have to be written as a character class and a class of
 *     combining marks is one nobody can read — each mark renders on top of the
 *     bracket or the dash beside it, so the class shows something other than
 *     what it matches. Broader than Arabic, and that is the right direction:
 *     after NFKC a mark still standing alone is one the writer typed, and
 *     dropping it can only make two spellings of the same word agree.
 *   * `U+0640` — the tatweel (kashida), which is not a mark at all. It is a
 *     stretching character inserted purely for justification, so it carries no
 *     meaning and must not survive into the comparison.
 */
const ARABIC_MARKS = /\u0640|\p{Mn}/gu;

/** Runs of any whitespace, so a double space or a newline cannot break a match. */
const WHITESPACE_RUN = /\s+/g;

/**
 * The one normalisation both sides of the comparison go through.
 *
 * Exported because the keyword and the message must be normalised identically —
 * a second, subtly different copy on one side is precisely the bug this
 * function's existence prevents.
 */
export function normaliseForKeywordMatch(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_MARKS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}

/**
 * The keyword that matched, or `null`.
 *
 * The matched keyword rather than a boolean, so a log line can say *which*
 * phrase released the conversation — the first thing an admin asks when the bot
 * hands off more often than they expected.
 *
 * An empty or whitespace-only keyword never matches. It cannot reach here
 * through the API (the contract requires `min(1)`), but a row written before
 * that validation existed would otherwise match every message ever sent.
 */
export function matchHandoffKeyword(
  body: string | null,
  keywords: readonly string[],
): string | null {
  if (body === null) {
    return null;
  }

  const haystack = normaliseForKeywordMatch(body);

  if (haystack === '') {
    return null;
  }

  for (const keyword of keywords) {
    const needle = normaliseForKeywordMatch(keyword);

    if (needle !== '' && haystack.includes(needle)) {
      return keyword;
    }
  }

  return null;
}
