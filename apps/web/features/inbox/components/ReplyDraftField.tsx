'use client';

import { type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { CANNED_RESPONSE_TRIGGER, type CannedResponseResponse } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { useContent } from '@/lib/content';
import { useCannedResponsePicker } from '@/features/inbox/useCannedResponsePicker';
import { CannedResponsePicker } from './CannedResponsePicker';
import styles from './ReplyDraftField.module.css';

/**
 * The reply textarea and the canned-response picker over it. Usage:
 *
 * ```tsx
 * <ReplyDraftField
 *   value={body}
 *   onChange={setBody}
 *   textareaRef={textareaRef}
 *   cannedResponses={cannedResponses}
 *   maxLength={maxLength}
 *   isDisabled={!isWindowOpen}
 *   error={…}
 *   isRequired={…}
 * />
 * ```
 *
 * Split out of `FreeFormComposer` because the form and the picker change for
 * different reasons: the form owns a draft, an attachment and a send, and this
 * owns one control and the menu that writes into it.
 *
 * ## With no canned responses, this is the textarea it always was
 *
 * A tenant with an empty library — or one whose library could not be read — gets
 * the field with no picker, no key handling and no ARIA describing a list that
 * does not exist. ADR 0011 is explicit that a failed load degrades to "the
 * composer behaves exactly as it does today", and the cheapest way to keep that
 * promise is to attach nothing at all rather than to attach a picker that is
 * always empty.
 *
 * ## Why the textarea is not a `combobox`
 *
 * "ARIA in HTML" does not allow a `role` on `<textarea>`, so this uses what a
 * `textbox` does support: `aria-autocomplete`, `aria-controls` and
 * `aria-activedescendant` naming the highlighted row, plus a polite status
 * region reporting how many entries the token matches. Announcing a role the
 * markup is not allowed to carry would be a worse trade than losing
 * `aria-expanded`, which the status region covers in words.
 */

export interface ReplyDraftFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** The composer keeps this to refocus the box after a send. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The tenant's whole library, server-rendered. Empty is the ordinary case. */
  cannedResponses: readonly CannedResponseResponse[];
  maxLength: number;
  isDisabled: boolean;
  /** The box's *floor*. It grows from here as the draft does — see the module. */
  rows: number;
  /**
   * The composer's expand control (TAR-518). It raises the ceiling the box grows
   * to; it does not change the floor, so pressing it never moves the text
   * already on screen.
   */
  isExpanded?: boolean;
  error?: string;
  isRequired?: boolean;
}

export function ReplyDraftField({
  value,
  onChange,
  textareaRef,
  cannedResponses,
  maxLength,
  isDisabled,
  rows,
  isExpanded = false,
  error,
  isRequired = false,
}: ReplyDraftFieldProps) {
  const content = useContent();
  const hasCannedResponses = cannedResponses.length > 0;
  const picker = useCannedResponsePicker({
    responses: cannedResponses,
    draft: value,
    onDraftChange: onChange,
    textareaRef,
  });

  const syncPicker = (target: HTMLTextAreaElement): void => {
    if (!hasCannedResponses) {
      return;
    }

    picker.sync(target.value, target.selectionStart, target.selectionEnd);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Nothing else may act on the key the picker consumed — `Enter` in
    // particular has to stop at the highlighted entry rather than reaching the
    // draft as a newline, and `Tab` has to commit rather than leave the field.
    if (picker.handleKeyDown(event.key)) {
      event.preventDefault();
    }
  };

  return (
    <Field
      label={content.composer.replyLabel}
      /*
       * Visible only where it says something the reader cannot already see. The
       * label repeated the composer's own "Reply on WhatsApp" tab above it, and
       * the plain hint repeated it again — three sentences of chrome over every
       * reply an agent writes (TAR-518). The shortcut hint stays, because a `/`
       * that nothing announces is a feature nobody finds.
       */
      isLabelHidden
      hint={
        hasCannedResponses
          ? content.composer.replyHintWithShortcuts(CANNED_RESPONSE_TRIGGER)
          : undefined
      }
      error={error}
      isRequired={isRequired}
    >
      {({ controlId, describedBy, isInvalid }) => (
        <div className={styles.anchor}>
          <Textarea
            id={controlId}
            ref={textareaRef}
            name="body"
            className={styles.draft}
            data-expanded={isExpanded ? 'true' : 'false'}
            value={value}
            rows={rows}
            maxLength={maxLength}
            disabled={isDisabled}
            placeholder={content.composer.replyPlaceholder}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            aria-autocomplete={hasCannedResponses ? 'list' : undefined}
            aria-controls={picker.isOpen ? picker.listboxId : undefined}
            aria-activedescendant={picker.activeOptionId}
            onChange={(event) => {
              onChange(event.target.value);
              syncPicker(event.target);
            }}
            onSelect={(event: SyntheticEvent<HTMLTextAreaElement>) => {
              syncPicker(event.currentTarget);
            }}
            onKeyDown={onKeyDown}
            onBlur={picker.close}
          />

          {picker.isOpen ? (
            <CannedResponsePicker
              id={picker.listboxId}
              label={content.composer.cannedListLabel}
              options={picker.matches}
              activeIndex={picker.activeIndex}
              optionId={picker.optionId}
              onCommit={picker.commit}
            />
          ) : null}

          {/* Mounted for as long as the feature is available rather than only
              while the list is open, so the first `/` is announced too — a live
              region that arrives with its message is a message screen readers
              routinely miss. */}
          {hasCannedResponses ? (
            <VisuallyHidden as="p">
              <span role="status">
                {picker.isOpen ? content.composer.cannedMatchCount(picker.matches.length) : ''}
              </span>
            </VisuallyHidden>
          ) : null}
        </div>
      )}
    </Field>
  );
}
