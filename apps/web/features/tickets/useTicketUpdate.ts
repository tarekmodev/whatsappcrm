'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TicketUpdateInput } from '@whatsappcrm/contracts';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm, type UseActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { updateTicketAction, type TicketUpdateResult } from '@/features/tickets/tickets.actions';

/**
 * One `PATCH /tickets/{id}` from a control, with its pending state, its inline
 * error and its toast. Usage:
 *
 * ```tsx
 * const { apply, isPending, formError } = useTicketUpdate(ticket.id);
 * apply({ status: 'pending' });
 * ```
 *
 * Extracted because the status control, the priority control and the resolve
 * confirmation all need the identical sequence, and because the two things that
 * are easy to get wrong belong in one place:
 *
 *   1. **The view is refetched whatever happened.** A `conflict` means the row
 *      moved under the agent — the customer replied and the ticket reopened — and
 *      the *reason* they need to see is the new inbound message, not the error
 *      text. Refreshing on failure as well as on success is what puts it there.
 *   2. **The toast names what actually changed**, read back from the response
 *      rather than from what was asked for, so a no-op still reports the truth.
 */

export interface UseTicketUpdate extends UseActionForm {
  apply: (patch: TicketUpdateInput) => void;
  /**
   * The patch currently in flight, or `null`. Lets a panel with several controls
   * put the pending state on the one that was pressed rather than on all of
   * them — `isPending` alone cannot tell them apart.
   */
  pendingPatch: TicketUpdateInput | null;
}

export function useTicketUpdate(ticketId: string, onApplied?: () => void): UseTicketUpdate {
  const content = useContent();
  const router = useRouter();
  const { showToast } = useToast();
  // A ref, not state: `apply` sets the patch and submits in the same tick, and a
  // state update would not have landed by the time `perform` reads it.
  const patchRef = useRef<TicketUpdateInput | null>(null);
  const [pendingPatch, setPendingPatch] = useState<TicketUpdateInput | null>(null);

  const perform = useCallback(async () => {
    const patch = patchRef.current;

    if (patch === null) {
      throw new Error('useTicketUpdate: submitted with no patch.');
    }

    const result = await updateTicketAction(ticketId, patch);

    router.refresh();

    return result;
  }, [router, ticketId]);

  const onSuccess = useCallback(
    (result: TicketUpdateResult) => {
      showToast({
        tone: 'success',
        message:
          patchRef.current?.status === undefined
            ? content.tickets.priorityChangeSuccess(
                result.label,
                content.ticketPriorities[result.priority],
              )
            : content.tickets.statusChangeSuccess(
                result.label,
                content.ticketStatuses[result.status],
              ),
      });
      onApplied?.();
    },
    [content, onApplied, showToast],
  );

  const form = useActionForm({ perform, onSuccess });
  const { submit, isPending } = form;

  // Released on both endings — `useActionForm` reports success and failure
  // through the same `isPending` edge, and there is no error callback to hang
  // this on.
  useEffect(() => {
    if (!isPending) {
      setPendingPatch(null);
    }
  }, [isPending]);

  const apply = useCallback(
    (patch: TicketUpdateInput) => {
      patchRef.current = patch;
      setPendingPatch(patch);
      submit();
    },
    [submit],
  );

  return { ...form, apply, pendingPatch };
}
