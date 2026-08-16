'use client';

import { useEffect, useRef } from 'react';
import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import styles from './CannedResponsePicker.module.css';

/**
 * The list of canned responses a typed shortcut matches. Usage, inside the
 * positioned wrapper around the reply textarea:
 *
 * ```tsx
 * <CannedResponsePicker
 *   id={picker.listboxId}
 *   label={content.composer.cannedListLabel}
 *   options={picker.matches}
 *   activeIndex={picker.activeIndex}
 *   optionId={picker.optionId}
 *   onCommit={picker.commit}
 * />
 * ```
 *
 * Presentation only: which entries these are, which one is highlighted and what
 * choosing one does are all `useCannedResponsePicker`'s.
 *
 * ## Why focus never comes here
 *
 * The agent is typing. A picker that moved focus would take the caret out of the
 * draft on the first keystroke after `/`, and put it back somewhere on commit.
 * So this is a listbox the textarea *points at* — `aria-activedescendant` names
 * the highlighted row, the arrow keys are handled by the field, and focus stays
 * in the box the whole time. The rows are `<li role="option">` rather than
 * buttons for the same reason: an option is not a tab stop.
 *
 * A pointer commit works the same way. `mousedown` is prevented so the textarea
 * never blurs, which keeps the caret — and therefore the token being replaced —
 * exactly where it was when the row was drawn.
 */

export interface CannedResponsePickerProps {
  id: string;
  /** Names the list for screen readers; it has no visible heading. */
  label: string;
  options: readonly CannedResponseResponse[];
  activeIndex: number;
  optionId: (index: number) => string;
  onCommit: (index: number) => void;
}

export function CannedResponsePicker({
  id,
  label,
  options,
  activeIndex,
  optionId,
  onCommit,
}: CannedResponsePickerProps) {
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    // `nearest`, so arrowing through a long list scrolls the row into view
    // without moving the page under the composer.
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <ul id={id} role="listbox" aria-label={label} className={styles.list}>
      {options.map((option, index) => (
        <li
          key={option.id}
          id={optionId(index)}
          ref={index === activeIndex ? activeRef : null}
          role="option"
          aria-selected={index === activeIndex}
          data-active={index === activeIndex}
          className={styles.option}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            onCommit(index);
          }}
        >
          <span className={styles.shortcut}>{option.shortcut}</span>
          <span className={styles.title}>{option.title}</span>
        </li>
      ))}
    </ul>
  );
}
