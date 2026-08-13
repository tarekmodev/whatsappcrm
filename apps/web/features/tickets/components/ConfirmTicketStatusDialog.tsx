'use client';

import { FormDialog } from '@/components/ui/FormDialog';
import { useContent } from '@/lib/content';
import type { TerminalTicketStatus } from '@/features/tickets/presentation';

/**
 * Confirms a one-way move. Usage:
 * `<ConfirmTicketStatusDialog status="resolved" label={…} onConfirm={…} onClose={…} … />`.
 *
 * Only `resolved` and `closed` reach here, and the type says so: those are the
 * two transitions with no way back at v1 — there is no reopen window, and
 * `TICKET_STATUS_TRANSITIONS` refuses every move out of them. Everything else on
 * this surface is reversible by the control that made it, and a modal in front of
 * an action you can undo in a click is friction dressed as safety.
 *
 * Presentational: the write, its pending state and its error all belong to the
 * control that opened this, so a failure renders in the dialog the agent is
 * looking at rather than behind it.
 */

export interface ConfirmTicketStatusDialogProps {
  status: TerminalTicketStatus;
  /** The ticket's subject, or its number when it has none. */
  label: string;
  isPending: boolean;
  formError: string | null;
  requestId: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmTicketStatusDialog({
  status,
  label,
  isPending,
  formError,
  requestId,
  onConfirm,
  onClose,
}: ConfirmTicketStatusDialogProps) {
  const content = useContent();
  const copy = content.tickets.terminalConfirm[status];

  return (
    <FormDialog
      isOpen
      title={copy.title}
      submitLabel={copy.confirm}
      submitVariant="danger"
      isPending={isPending}
      formError={formError}
      requestId={requestId}
      onClose={onClose}
      onSubmit={onConfirm}
    >
      <p>{copy.body(label)}</p>
    </FormDialog>
  );
}
