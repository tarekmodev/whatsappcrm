'use client';

import { useCallback, useState } from 'react';
import type { UserResponse } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { reassignTicketAction } from '@/features/tickets/ticket-handoff.actions';
import { TicketReasonField, validateTicketReason } from './TicketReasonField';

/**
 * Hands a ticket to a teammate, with a reason. Usage:
 * `<ReassignTicketDialog ticketId={…} label={…} teammates={…} onClose={…} />`.
 *
 * **The reason is required and the form will not submit without one** — TAR-32's
 * first acceptance criterion. The check runs on submit rather than disabling the
 * button, deliberately: a button that silently will not press explains nothing,
 * while an error in the field's own slot can be read and acted on. The server
 * action re-checks it and the API refuses the same call a third time.
 *
 * Not a confirmation step: reassigning is reversible by reassigning again, so a
 * second "are you sure?" in front of it would be noise. The picker is bounded to
 * people the API will accept — see `loadHandoffCandidates`.
 */
export function ReassignTicketDialog({
  ticketId,
  label,
  teammates,
  onClose,
}: {
  ticketId: string;
  /** The ticket's subject, or its number when it has none. */
  label: string;
  /** Already narrowed to who this principal may hand to; may be empty. */
  teammates: readonly UserResponse[];
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const firstUserId = teammates[0]?.id ?? '';
  const [userId, setUserId] = useState(firstUserId);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);

  const perform = useCallback(
    async () => reassignTicketAction(ticketId, { userId, reason: reason.trim() }),
    [reason, ticketId, userId],
  );

  const onSuccess = useCallback(() => {
    const agentName =
      teammates.find((user) => user.id === userId)?.displayName ?? content.common.unassigned;

    showToast({
      tone: 'success',
      // Names the ticket and the person, not "Done": the agent is handing work
      // away and the toast is the last confirmation of where it went.
      message: content.tickets.reassignSuccess(label, agentName),
    });
    onClose();
  }, [content, label, onClose, showToast, teammates, userId]);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });
  const hasTeammates = teammates.length > 0;

  return (
    <FormDialog
      isOpen
      title={content.tickets.reassignTitle(label)}
      description={content.tickets.reassignDescription}
      submitLabel={content.tickets.reassignSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        const error = validateTicketReason(reason, content);

        setReasonError(error);

        // The AC, enforced: nothing is sent while the reason is missing or too
        // short. `Field` has already wired the message to the control through
        // `aria-describedby`, so it is announced rather than only drawn.
        if (error !== undefined) {
          return;
        }

        submit();
      }}
      // A precondition the agent cannot satisfy from here, which is the only
      // thing this prop is for — the reason's own error belongs in its field.
      isSubmitDisabled={!hasTeammates}
    >
      {hasTeammates ? (
        <>
          <Field
            label={content.tickets.reassignAgentLabel}
            hint={content.tickets.reassignAgentHint}
            isRequired
          >
            {({ controlId, describedBy }) => (
              <Select
                id={controlId}
                aria-describedby={describedBy}
                name="userId"
                value={userId}
                disabled={isPending}
                options={teammates.map((user) => ({
                  value: user.id,
                  label: user.displayName,
                }))}
                onChange={(event) => {
                  setUserId(event.target.value);
                }}
              />
            )}
          </Field>

          <TicketReasonField
            label={content.tickets.reassignReasonLabel}
            hint={content.tickets.reassignReasonHint}
            value={reason}
            error={reasonError}
            isDisabled={isPending}
            onChange={(next) => {
              setReason(next);

              // Cleared as soon as they start fixing it. Leaving a stale error
              // under a field the agent has already corrected reads as a form
              // that is not listening.
              if (reasonError !== undefined) {
                setReasonError(undefined);
              }
            }}
          />
        </>
      ) : (
        // The teammate bound seen from inside the dialog with nobody on the
        // other side of it. An empty picker would read as a broken control.
        <Notice tone="warning">{content.tickets.reassignNoTeammates}</Notice>
      )}
    </FormDialog>
  );
}
