'use client';

import { CANNED_RESPONSE_LIMITS, CANNED_RESPONSE_TRIGGER } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { Textarea } from '@/components/ui/Textarea';
import { useContent } from '@/lib/content';
import { CANNED_RESPONSE_BODY_ROWS } from '../constants';
import type { CannedResponseDraftForm } from '../useCannedResponseDraft';

/**
 * The three fields a saved reply is made of. Usage:
 * `<CannedResponseFields form={form} isDisabled={isPending} />`.
 *
 * Shared by the create and edit dialogs, which is the point: both write all
 * three — a shortcut is what an agent types rather than what a stored value is
 * filed under, so unlike a custom field's key none of it is immutable — and two
 * copies of the same three boxes would drift in their hints first and their
 * `maxLength`s second.
 *
 * Every cap comes from `CANNED_RESPONSE_LIMITS`, so the control stops the
 * keystroke at exactly the length the contract refuses.
 */
export function CannedResponseFields({
  form,
  isDisabled,
}: {
  form: CannedResponseDraftForm;
  isDisabled: boolean;
}) {
  const content = useContent();
  const { draft, issues, change, normaliseShortcutNow } = form;

  return (
    <>
      <Field
        label={content.cannedResponses.shortcutLabel}
        hint={content.cannedResponses.shortcutHint(CANNED_RESPONSE_TRIGGER)}
        error={issues.shortcut}
        isRequired
      >
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="shortcut"
            autoComplete="off"
            spellCheck={false}
            // An identifier the agent types verbatim, so it reads
            // left-to-right even when the console is in RTL.
            dir="ltr"
            disabled={isDisabled}
            // One less while the box has no leading trigger, because blur is
            // about to add one: `shortcutLength` counts the `/`, so a full 40
            // characters typed without it would normalise to 41 and be refused
            // by a control that had just accepted exactly that input.
            maxLength={shortcutMaxLength(draft.shortcut)}
            placeholder={content.cannedResponses.shortcutPlaceholder}
            value={draft.shortcut}
            onChange={(event) => {
              change({ shortcut: event.target.value });
            }}
            // On blur rather than on the keystroke: rewriting the value under a
            // cursor mid-word is how a text field starts eating characters.
            onBlur={normaliseShortcutNow}
          />
        )}
      </Field>

      <Field
        label={content.cannedResponses.nameLabel}
        hint={content.cannedResponses.nameHint}
        error={issues.title}
        isRequired
      >
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="title"
            autoComplete="off"
            disabled={isDisabled}
            maxLength={CANNED_RESPONSE_LIMITS.titleLength}
            placeholder={content.cannedResponses.namePlaceholder}
            value={draft.title}
            onChange={(event) => {
              change({ title: event.target.value });
            }}
          />
        )}
      </Field>

      <Field
        label={content.cannedResponses.textLabel}
        hint={content.cannedResponses.textHint}
        error={issues.body}
        isRequired
      >
        {({ controlId, describedBy, isInvalid }) => (
          <Textarea
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            name="body"
            rows={CANNED_RESPONSE_BODY_ROWS}
            disabled={isDisabled}
            maxLength={CANNED_RESPONSE_LIMITS.bodyLength}
            placeholder={content.cannedResponses.textPlaceholder}
            value={draft.body}
            onChange={(event) => {
              change({ body: event.target.value });
            }}
          />
        )}
      </Field>
    </>
  );
}

/**
 * The cap the shortcut box stops at, measured on what the value will *become*
 * rather than on what it currently is.
 *
 * `CANNED_RESPONSE_LIMITS.shortcutLength` counts the leading `/`, and
 * `normaliseShortcut` adds one on blur when the admin has not typed it. Without
 * this, pasting 40 characters with no slash fills the box to its own limit and
 * then fails validation at 41 — a control refusing exactly the input it just
 * accepted, which reads as a bug even though the message is correct.
 */
function shortcutMaxLength(value: string): number {
  return value.startsWith(CANNED_RESPONSE_TRIGGER)
    ? CANNED_RESPONSE_LIMITS.shortcutLength
    : CANNED_RESPONSE_LIMITS.shortcutLength - 1;
}
