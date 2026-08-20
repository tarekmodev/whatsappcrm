'use client';

import { useCallback, useState } from 'react';
import { ticketAssignRequiresReason, type UserResponse } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { FormDialog } from '@/components/ui/FormDialog';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import {
  TicketReasonField,
  validateTicketReason,
} from '@/features/tickets/components/TicketReasonField';
import { assignFlaggedTicketAction } from '../assignment.actions';
import type { FlaggedTicketRow } from '../flagged-rows';
import { ticketLabel } from '../ticket-label';

/**
 * Places a ticket auto-assignment could not. Usage:
 * `<AssignFlaggedTicketDialog row={row} assignableUsers={users} onClose={…} />`.
 *
 * A picker, not a confirmation, and it deliberately does **not** hide agents who
 * are at their limit or away: the whole reason this ticket is here is that nobody
 * passed those tests, so a list filtered by them would be empty exactly when it is
 * needed. The description says the override is what it is, so a supervisor makes
 * the call knowingly.
 *
 * The write is reversible — reassigning is the same endpoint with a different
 * name — so there is no second confirmation step in front of it.
 *
 * **The reason follows the contract's own predicate rather than being demanded
 * outright** (TAR-537). `ticketAssignRequiresReason` is about the ticket's
 * current holder, and a ticket in this queue has none: every writer of
 * `routing_state` leaves a `deferred` ticket with both assignment columns null —
 * a matched rule assigns terminally, and rotation-with-nobody defers without
 * touching them. So the field is optional on every row this queue can show, and
 * asking anyway would be the mandatory free-text field in front of bulk triage
 * that ADR 0011 decision 1 rejected. The predicate is called rather than that
 * conclusion hardcoded, so the day a deferred ticket can carry a holder the
 * asterisk comes back on its own.
 */
export function AssignFlaggedTicketDialog({
  row,
  assignableUsers,
  onClose,
}: {
  row: FlaggedTicketRow;
  assignableUsers: readonly UserResponse[];
  onClose: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();
  const label = ticketLabel(row.ticket, content);
  const firstUserId = assignableUsers[0]?.id ?? '';
  const [userId, setUserId] = useState(firstUserId);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const isReasonRequired = ticketAssignRequiresReason(row.ticket);
  const trimmedReason = reason.trim();

  const perform = useCallback(
    async () =>
      assignFlaggedTicketAction(row.ticket.id, {
        userId,
        // Omitted, not sent empty: `reason` is `.trim().min(3).optional()`, so
        // `''` is a refusal rather than "no reason given".
        reason: trimmedReason === '' ? undefined : trimmedReason,
      }),
    [row.ticket.id, trimmedReason, userId],
  );

  const onSuccess = useCallback(() => {
    const agentName =
      assignableUsers.find((user) => user.id === userId)?.displayName ?? content.common.unassigned;

    showToast({
      tone: 'success',
      // Specific, not "Done": the row is about to leave the queue, so the toast is
      // the only remaining record of where it went.
      message: content.assignment.assignTicketSuccess(label, agentName),
    });
    onClose();
  }, [assignableUsers, content, label, onClose, showToast, userId]);

  const { submit, isPending, formError, requestId } = useActionForm({ perform, onSuccess });
  const hasAgents = assignableUsers.length > 0;

  return (
    <FormDialog
      isOpen
      title={content.assignment.assignTicketTitle(label)}
      description={content.assignment.assignTicketDescription}
      submitLabel={content.assignment.assignTicketSubmit}
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={() => {
        // Still validated when it is optional: a reason of two characters is a
        // 422 whether or not one was demanded, and catching it here beats a
        // round trip to be told.
        const error = validateTicketReason(reason, content, { isRequired: isReasonRequired });

        setReasonError(error);

        if (error !== undefined) {
          return;
        }

        submit();
      }}
      // Nothing to assign to is a precondition the supervisor cannot fix from
      // this dialog, so the button is blocked rather than left to fail on the
      // server with a message that explains less than the notice below does.
      isSubmitDisabled={!hasAgents}
    >
      {hasAgents ? (
        <>
          <Field
            label={content.assignment.assignTicketAgentLabel}
            hint={content.assignment.assignTicketAgentHint}
            isRequired
          >
            {({ controlId, describedBy }) => (
              <Select
                id={controlId}
                aria-describedby={describedBy}
                name="userId"
                value={userId}
                disabled={isPending}
                options={assignableUsers.map((user) => ({
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
            label={content.assignment.assignTicketReasonLabel}
            hint={content.assignment.assignTicketReasonHint(isReasonRequired)}
            value={reason}
            error={reasonError}
            isDisabled={isPending}
            isRequired={isReasonRequired}
            onChange={(next) => {
              setReason(next);

              if (reasonError !== undefined) {
                setReasonError(undefined);
              }
            }}
          />
        </>
      ) : (
        // The `no_candidate_pool` case seen from inside the dialog. An empty
        // picker would read as a broken control; this says what is missing.
        <Notice tone="warning">{content.assignment.assignTicketNoAgentsError}</Notice>
      )}
    </FormDialog>
  );
}
