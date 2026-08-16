'use client';

import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { useContent } from '@/lib/content';
import { TICKET_REASON_LIMITS } from '@/features/tickets/constants';

/**
 * The required `reason` both handoff dialogs take. Usage:
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
 */

export interface TicketReasonFieldProps {
  label: string;
  hint: string;
  value: string;
  /** Shown under the control; set only after a submit attempt. */
  error: string | undefined;
  isDisabled: boolean;
  onChange: (value: string) => void;
}

export function TicketReasonField({
  label,
  hint,
  value,
  error,
  isDisabled,
  onChange,
}: TicketReasonFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} isRequired>
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
 */
export function validateTicketReason(value: string, content: ReturnType<typeof useContent>) {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return content.tickets.reasonRequiredError;
  }

  if (trimmed.length < TICKET_REASON_LIMITS.minLength) {
    return content.tickets.reasonTooShortError(TICKET_REASON_LIMITS.minLength);
  }

  if (trimmed.length > TICKET_REASON_LIMITS.maxLength) {
    return content.tickets.reasonTooLongError(TICKET_REASON_LIMITS.maxLength);
  }

  return undefined;
}
