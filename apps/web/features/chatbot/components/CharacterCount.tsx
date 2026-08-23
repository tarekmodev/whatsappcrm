'use client';

import { useContent } from '@/lib/content';
import styles from './CharacterCount.module.css';

/**
 * How much room is left in a capped text field. Usage, inside a `Field` and
 * named in the control's `aria-describedby`:
 *
 * ```tsx
 * <CharacterCount id={countId} length={value.length} limit={AI_CONFIG_LIMITS.systemPromptLength} />
 * ```
 *
 * **Room left, not characters used.** "3,214 of 4,000" makes a reader do the
 * subtraction; the number they actually want is how much more they can write.
 *
 * **Part of the field's description, never a loose paragraph.** The caller adds
 * this `id` to the control's `aria-describedby`, so a screen-reader user hears
 * the remaining room when they reach the field rather than never — which is the
 * project's standing rule for help text that explains the current value.
 *
 * The over-cap branch exists even though both fields carry a `maxLength`: paste
 * and IME composition can both land past a cap in browsers, and a counter that
 * cannot count past zero would report "0 characters left" on a value the API is
 * about to refuse.
 */
export function CharacterCount({
  id,
  length,
  limit,
}: {
  id: string;
  length: number;
  limit: number;
}) {
  const content = useContent();
  const remaining = limit - length;

  return (
    <p id={id} className={styles.count} data-over={remaining < 0}>
      {remaining < 0
        ? content.chatbot.charactersOver(-remaining)
        : content.chatbot.charactersLeft(remaining)}
    </p>
  );
}
