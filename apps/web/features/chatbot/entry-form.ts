import {
  AI_CONFIG_LIMITS,
  KNOWLEDGE_DOCUMENT_LIMITS,
  withinKnowledgeContentCap,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';

/**
 * Client-side validation for the two chatbot forms, in one module so the rules
 * are testable without rendering anything.
 *
 * It validates against the **contract's own limits**, imported rather than
 * restated, so a bound that moves in `ai.ts` moves here too. This is a
 * convenience, not the boundary: the server action re-parses with the same
 * schema and the API refuses independently. What it buys is that an entry
 * somebody spent ten minutes writing is not lost to a round trip that could have
 * been answered on the spot.
 */

export interface EntryErrors {
  title?: string;
  content?: string;
  sourceUrl?: string;
}

export interface EntryValues {
  title: string;
  body: string;
  sourceUrl: string;
}

export function validateEntry(values: EntryValues): EntryErrors {
  const errors: EntryErrors = {};
  const title = values.title.trim();
  const body = values.body.trim();
  const sourceUrl = values.sourceUrl.trim();

  if (title.length === 0) {
    errors.title = content.form.requiredFieldError;
  } else if (title.length > KNOWLEDGE_DOCUMENT_LIMITS.titleLength) {
    errors.title = content.chatbot.entryTitleTooLongError(KNOWLEDGE_DOCUMENT_LIMITS.titleLength);
  }

  if (body.length === 0) {
    errors.content = content.form.requiredFieldError;
  } else if (!withinKnowledgeContentCap(body)) {
    // The contract's own predicate, not `body.length`: the cap is named in
    // UTF-8 bytes and a code-unit count accepts roughly twice it in Arabic or
    // Chinese. Measuring it differently here is worse than not measuring it —
    // the entry passes, the round trip is spent, and the API refuses it with a
    // byte count nobody was shown.
    errors.content = content.chatbot.entryContentTooLongError;
  }

  if (sourceUrl.length > 0 && !isHttpUrl(sourceUrl)) {
    errors.sourceUrl = content.chatbot.entrySourceUrlInvalidError;
  }

  return errors;
}

/**
 * Whether a source URL is one a browser would actually open.
 *
 * A real `URL` parse rather than a regular expression, and a scheme check on top
 * of it: `javascript:alert(1)` parses perfectly, and this value is rendered as a
 * link for the tenant's own team.
 */
function isHttpUrl(value: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * The handoff keywords, one per line, as the contract wants them.
 *
 * Blank lines and stray whitespace are dropped rather than rejected: a list
 * typed into a textarea acquires them by accident, and refusing a save over a
 * trailing newline would be a refusal about something nobody chose. Duplicates
 * collapse for the same reason — the matcher would only ever use the first.
 */
export function parseKeywords(raw: string): string[] {
  const seen = new Set<string>();

  for (const line of raw.split('\n')) {
    const keyword = line.trim();

    if (keyword.length > 0) {
      seen.add(keyword);
    }
  }

  return [...seen];
}

/** The stored list back into the textarea's shape. */
export function formatKeywords(keywords: readonly string[]): string {
  return keywords.join('\n');
}

export interface SettingsValues {
  keywords: readonly string[];
  /** The raw field value, so an emptied number input is distinguishable from a zero. */
  maxBotTurns: string;
}

export interface SettingsErrors {
  handoffKeywords?: string;
  maxBotTurns?: string;
}

/**
 * The settings form's two checkable fields: the keyword list, and how many
 * replies the chatbot may send.
 *
 * Keyword length is checked per keyword rather than on the textarea as a whole,
 * because the limit is per keyword: a textarea `maxLength` would either stop
 * somebody entering a fifth valid word or let through a single 200-character
 * one.
 *
 * `maxBotTurns` is checked as the **string the input holds**, not as the number
 * it coerces to. An emptied number field coerces to `0`, which is a value the
 * contract refuses and nobody typed — it reached the API as a generic failure
 * with nothing on screen highlighted. A browser also reports a half-typed
 * `type="number"` value as `''`, so "empty" and "not a number" are one case
 * here and get one message that says what a valid answer looks like.
 */
export function validateSettings({ keywords, maxBotTurns }: SettingsValues): SettingsErrors {
  const errors: SettingsErrors = {};

  if (keywords.length > AI_CONFIG_LIMITS.handoffKeywordCount) {
    errors.handoffKeywords = content.chatbot.handoffKeywordsTooManyError(
      AI_CONFIG_LIMITS.handoffKeywordCount,
    );
  } else if (keywords.some((keyword) => keyword.length > AI_CONFIG_LIMITS.handoffKeywordLength)) {
    errors.handoffKeywords = content.chatbot.handoffKeywordTooLongError(
      AI_CONFIG_LIMITS.handoffKeywordLength,
    );
  }

  if (!isBotTurnCount(maxBotTurns)) {
    errors.maxBotTurns = content.chatbot.maxTurnsInvalidError(
      AI_CONFIG_LIMITS.minBotTurns,
      AI_CONFIG_LIMITS.maxBotTurns,
    );
  }

  return errors;
}

/** A whole number inside the contract's turn bounds, read from a raw field value. */
function isBotTurnCount(raw: string): boolean {
  const trimmed = raw.trim();

  if (trimmed === '') {
    return false;
  }

  const parsed = Number(trimmed);

  return (
    Number.isInteger(parsed) &&
    parsed >= AI_CONFIG_LIMITS.minBotTurns &&
    parsed <= AI_CONFIG_LIMITS.maxBotTurns
  );
}
