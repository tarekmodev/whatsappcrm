'use client';

import { useCallback, useState } from 'react';
import type { UserResponse } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { escalateTicketAction } from '@/features/tickets/ticket-handoff.actions';
import { TicketReasonField, validateTicketReason } from './TicketReasonField';

/**
 * Asks a supervisor to look at a ticket. Usage:
 * `<EscalateTicketDialog ticketId={…} label={…} supervisors={…} onClose={…} />`.
 *
 * **The reason is required and the form will not submit without one** — TAR-32's
 * second acceptance criterion — checked the same way `ReassignTicketDialog`
 * checks it, through the same field.
 *
 * Two things this dialog has to say that the reassign one does not:
 *
 *   * **the ticket does not change hands.** The description says so, because an
 *     agent who read "Escalate" as "give it away" would stop using the button
 *     the moment they needed it most (ADR 0011 decision 3);
 *   * **who was actually told.** `notifiedUserIds` can come back empty from a
 *     tenant with no active supervisor. That is a real outcome, not a failure,
 *     and it gets its own toast rather than a green tick that would be a lie.
 *
 * The supervisor picker is optional. Its first option is "whoever is covering
 * this ticket", which is the `toUserId`-absent case named rather than left as a
 * blank entry — and it is the default, because the derived recipient set is
 * wider and more likely to reach somebody awake.
 */
export function EscalateTicketDialog({
  ticketId,
  label,
  supervisors,
  onClose,
}: {
  ticketId: string;
  /** The ticket's subject, or its number when it has none. */
  label: string;
  /** Who may be named. Empty is fine — the derived option always stands. */
  supervisors: readonly UserResponse[];
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const [toUserId, setToUserId] = useState(ANYONE);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);

  const perform = useCallback(
    async () =>
      escalateTicketAction(ticketId, {
        reason: reason.trim(),
        // Omitted rather than sent as an empty string: absent is what the
        // contract spells "whoever supervises this ticket".
        ...(toUserId === ANYONE ? {} : { toUserId }),
      }),
    [reason, ticketId, toUserId],
  );

  const onSuccess = useCallback(
    ({ notifiedCount }: { notifiedCount: number }) => {
      showToast({
        // Recorded but undeliverable is not a success and not an error. `info`
        // is the honest tone: the agent did nothing wrong and cannot fix it, and
        // the copy tells them who can.
        tone: notifiedCount === 0 ? 'info' : 'success',
        message:
          notifiedCount === 0
            ? content.tickets.escalateSuccessNobody(label)
            : content.tickets.escalateSuccess(label, notifiedCount),
      });
      onClose();
    },
    [content, label, onClose, showToast],
  );

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });

  return (
    <FormDialog
      isOpen
      title={content.tickets.escalateTitle(label)}
      description={content.tickets.escalateDescription}
      submitLabel={content.tickets.escalateSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        const error = validateTicketReason(reason, content);

        setReasonError(error);

        if (error !== undefined) {
          return;
        }

        submit();
      }}
    >
      <TicketReasonField
        label={content.tickets.escalateReasonLabel}
        hint={content.tickets.escalateReasonHint}
        value={reason}
        error={reasonError}
        isDisabled={isPending}
        onChange={(next) => {
          setReason(next);

          if (reasonError !== undefined) {
            setReasonError(undefined);
          }
        }}
      />

      <Field
        label={content.tickets.escalateSupervisorLabel}
        hint={content.tickets.escalateSupervisorHint}
      >
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            name="toUserId"
            value={toUserId}
            disabled={isPending}
            options={[
              { value: ANYONE, label: content.tickets.escalateSupervisorAnyone },
              ...supervisors.map((user) => ({ value: user.id, label: user.displayName })),
            ]}
            onChange={(event) => {
              setToUserId(event.target.value);
            }}
          />
        )}
      </Field>
    </FormDialog>
  );
}

/**
 * The sentinel for "send it to whoever covers this ticket".
 *
 * A non-UUID on purpose: it can never collide with a real user id, so a bug that
 * leaked it into the request body would be refused by `IdSchema` rather than
 * quietly naming somebody.
 */
const ANYONE = 'anyone';
