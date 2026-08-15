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

  const perform = useCallback(
    async () => assignFlaggedTicketAction(row.ticket.id, { userId }),
    [row.ticket.id, userId],
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
      onSubmit={submit}
      // Nothing to assign to is a precondition the supervisor cannot fix from
      // this dialog, so the button is blocked rather than left to fail on the
      // server with a message that explains less than the notice below does.
      isSubmitDisabled={!hasAgents}
    >
      {hasAgents ? (
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
      ) : (
        // The `no_candidate_pool` case seen from inside the dialog. An empty
        // picker would read as a broken control; this says what is missing.
        <Notice tone="warning">{content.assignment.assignTicketNoAgentsError}</Notice>
      )}
    </FormDialog>
  );
}
