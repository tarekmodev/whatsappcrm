import type { AiConfigResponse, UpdateAiConfigInput } from '@whatsappcrm/contracts';
import { formatKeywords, parseKeywords } from './entry-form';

/**
 * The chatbot settings a reader is editing, and what is different about them
 * (TAR-813).
 *
 * The page has three commit behaviours, and this covers exactly one of them: the
 * fields across stages B, C and D that are saved together from the sticky bar.
 * The master switch is deliberately **not** here — it writes on flip and has no
 * unsaved state to count — and neither is anything about a source, which writes
 * per dialog.
 *
 * Pure, so "is this dirty" and "how many changes is that" can be asserted
 * without rendering a form. Which matters more than it sounds: the save bar
 * appearing when nothing changed, or staying away when something did, is the one
 * bug on this page a reader cannot see until their work is gone.
 */

export interface SettingsDraft {
  /** A model id, or `''` for the platform default. */
  readonly model: string;
  readonly minConfidence: number;
  /** A string, not a number: an emptied field is a state the reader can be in. */
  readonly maxBotTurns: string;
  readonly systemPrompt: string;
  readonly handoffMessage: string;
  /** The textarea's raw text; `parseKeywords` is what turns it into the list. */
  readonly keywordText: string;
}

export function settingsDraft(config: AiConfigResponse): SettingsDraft {
  return {
    model: config.model ?? '',
    minConfidence: config.minConfidence,
    maxBotTurns: String(config.maxBotTurns),
    systemPrompt: config.systemPrompt ?? '',
    handoffMessage: config.handoffMessage ?? '',
    keywordText: formatKeywords(config.handoffKeywords),
  };
}

/**
 * How many fields differ from what is saved.
 *
 * **Compared the way they are sent, not the way they are typed.** A trailing
 * newline in the keyword box and a space at the end of the system prompt both
 * vanish on the way to the API, so counting them as changes would put a save bar
 * over a form with nothing to save — and then report "Saved" for a request that
 * changed nothing. `maxBotTurns` is the exception and is compared as text: `''`
 * is not a number yet, and it has to count as a change so the bar can appear and
 * carry the reader to the error.
 */
export function draftChangeCount(draft: SettingsDraft, saved: SettingsDraft): number {
  const comparisons: readonly boolean[] = [
    draft.model !== saved.model,
    draft.minConfidence !== saved.minConfidence,
    draft.maxBotTurns.trim() !== saved.maxBotTurns.trim(),
    draft.systemPrompt.trim() !== saved.systemPrompt.trim(),
    draft.handoffMessage.trim() !== saved.handoffMessage.trim(),
    !sameKeywords(parseKeywords(draft.keywordText), parseKeywords(saved.keywordText)),
  ];

  return comparisons.filter(Boolean).length;
}

/**
 * The `PATCH /ai/config` body, without `isEnabled`.
 *
 * Its absence is the contract being used as designed rather than an omission:
 * `UpdateAiConfigInput` is `.partial()`, so the switch's own request carries
 * `isEnabled` alone and this one leaves whatever the switch last wrote alone.
 * Sending a stale copy of it here is how a save of the system prompt would
 * silently switch the chatbot back on.
 */
export function draftInput(draft: SettingsDraft): UpdateAiConfigInput {
  return {
    // `''` is the empty choice, and the contract spells "the platform default"
    // `null`. Sending the empty string would fail its enum and read to the user
    // as a bug rather than as a choice they made.
    model: draft.model === '' ? null : asModel(draft.model),
    minConfidence: draft.minConfidence,
    maxBotTurns: Number(draft.maxBotTurns),
    systemPrompt: draft.systemPrompt.trim() === '' ? null : draft.systemPrompt.trim(),
    handoffMessage: draft.handoffMessage.trim() === '' ? null : draft.handoffMessage.trim(),
    handoffKeywords: parseKeywords(draft.keywordText),
  };
}

/**
 * Order matters, and it is not a sort. `parseKeywords` keeps the reader's own
 * order and drops duplicates, and moving a word up the box is a change they made
 * and would expect to be able to save.
 */
function sameKeywords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((keyword, index) => keyword === right[index]);
}

/**
 * The select's value is a `string` because that is what a `<select>` yields; the
 * contract wants one of three ids. The server action re-parses this against
 * `UpdateAiConfigInputSchema` and the API parses it again, so an id that is not
 * on the allowlist is refused twice more — this cast only keeps the shape honest
 * on the way out.
 */
function asModel(value: string): UpdateAiConfigInput['model'] {
  return value as UpdateAiConfigInput['model'];
}
