'use client';

import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { useContent } from '@/lib/content';
import { TICKET_REASON_LIMITS } from '@/features/tickets/constants';

/**
 * The `reason` the handoff dialogs take. Usage:
 *
 * ```tsx
 * <TicketReasonField label={…} hint={…} value={reason} error={reasonError}
 *                    isDisabled={isPending} onChange={setReason} />
 * ```
 *
 * Extracted the moment the second dialog needed it rather than copied: the
 * validation is the AC — the form must not submit without a reason — and two
 * copies of a rule that is also in the contract is two places for it to drift.
 *
 * `maxLength` is on the control so the ceiling cannot be exceeded at all, while
 * the floor is reported as an error after a submit attempt — a value too short
 * has to be *readable* to be fixable, so it is never silently blocked.
 *
 * Required by default, because a handoff takes work away from somebody and the
 * API says so. `isRequired={false}` is for the one caller placing work nobody
 * held — see `ticketAssignRequiresReason` — where the asterisk would promise a
 * gate the backend does not have (ADR 0011 decision 1).
 */

export interface TicketReasonFieldProps {
  label: string;
  hint: string;
  value: string;
  /** Shown under the control; set only after a submit attempt. */
  error: string | undefined;
  isDisabled: boolean;
  onChange: (value: string) => void;
  /** Defaults to `true`; pass the contract's predicate, not a guess. */
  isRequired?: boolean;
}

export function TicketReasonField({
  label,
  hint,
  value,
  error,
  isDisabled,
  onChange,
  isRequired = true,
}: TicketReasonFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} isRequired={isRequired}>
      {({ controlId, describedBy, isInvalid }) => (
        <Textarea
          id={controlId}
          name="reason"
          value={value}
          rows={3}
          maxLength={TICKET_REASON_LIMITS.maxLength}
          disabled={isDisabled}
          aria-describedby={describedBy}
          aria-invalid={isInvalid}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}

/**
 * The client half of the contract's `z.string().trim().min(3).max(500)`, so the
 * form can refuse before submitting instead of round-tripping to be told.
 *
 * Returns the message to show, or `undefined` when the value is acceptable. It
 * trims first for the reason the contract does: whitespace is not a reason, and
 * a field that counted spaces would let `'   '` through to a 400.
 *
 * `isRequired: false` excuses an *empty* value only — the field is `.optional()`
 * on the wire, not nullable-to-empty-string, so a caller omits it rather than
 * sending `''`. Anything actually typed still has to clear the floor and the
 * ceiling, because the API applies both the moment the field is present.
 */
export function validateTicketReason(
  value: string,
  content: ReturnType<typeof useContent>,
  { isRequired = true }: { isRequired?: boolean } = {},
) {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return isRequired ? content.tickets.reasonRequiredError : undefined;
  }

  if (trimmed.length < TICKET_REASON_LIMITS.minLength) {
    return content.tickets.reasonTooShortError(TICKET_REASON_LIMITS.minLength);
  }

  if (trimmed.length > TICKET_REASON_LIMITS.maxLength) {
    return content.tickets.reasonTooLongError(TICKET_REASON_LIMITS.maxLength);
  }

  return undefined;
}
