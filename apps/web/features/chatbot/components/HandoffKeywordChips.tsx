'use client';

import { AI_CONFIG_LIMITS } from '@whatsappcrm/contracts';
import { Icon } from '@/components/ui/Icon';
import { useContent } from '@/lib/content';
import { formatKeywords } from '../entry-form';
import styles from './HandoffKeywordChips.module.css';

/**
 * What the handoff-word box actually parsed to. Usage, under the textarea:
 * `<HandoffKeywordChips keywords={parseKeywords(text)} onChange={setText} … />`.
 *
 * **This is the visualisation, and it closes a real gap** (TAR-813). The stored
 * value is a list; the control is a textarea; `parseKeywords` trims each line,
 * drops the blanks and drops duplicates. Until now nothing on screen said what
 * that had made of what somebody typed — a trailing space, a word entered twice,
 * a line that was only whitespace all looked exactly like a word that would
 * match. The chips are the list, drawn.
 *
 * **The textarea stays the input of record.** These are a read-out with one
 * affordance, not a second editor: there is no "add a chip" control, because two
 * ways to write one value is two states to keep in step. Removing one rewrites
 * the box, so the box is still the thing that holds the truth.
 *
 * A word over the length cap is drawn in the danger role *and* named by the
 * field's own error above it — the error says what the rule is, the chip says
 * which word broke it, and neither is colour alone.
 */
export function HandoffKeywordChips({
  keywords,
  onChange,
  isDisabled,
}: {
  /** Already parsed — the same list the save sends. */
  keywords: readonly string[];
  /** Called with the rewritten textarea text when a chip is removed. */
  onChange: (keywordText: string) => void;
  isDisabled: boolean;
}) {
  const content = useContent();

  if (keywords.length === 0) {
    // Quiet, not an error: a workspace with no handoff words has not
    // misconfigured anything, and a customer can still reach a person.
    return <p className={styles.empty}>{content.chatbot.ruleKeywordsClauseEmpty}</p>;
  }

  return (
    <ul className={styles.list} aria-label={content.chatbot.handoffKeywordsPreviewLabel}>
      {keywords.map((keyword) => (
        // `parseKeywords` has already dropped duplicates, so the word itself is
        // a stable key — and a better one than an index, which would move every
        // chip's identity when one in the middle is removed.
        <li key={keyword}>
          <span
            className={styles.chip}
            data-invalid={keyword.length > AI_CONFIG_LIMITS.handoffKeywordLength}
          >
            <span className={styles.text}>{keyword}</span>
            {isDisabled ? null : (
              <button
                type="button"
                className={styles.remove}
                aria-label={content.chatbot.removeHandoffKeyword(keyword)}
                onClick={() => {
                  onChange(formatKeywords(keywords.filter((entry) => entry !== keyword)));
                }}
              >
                <Icon name="close" size="sm" />
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
