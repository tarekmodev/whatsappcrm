'use client';

import { useEffect, useId, useState } from 'react';
import type { TicketPriority, TicketStatus } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import { Notice } from '@/components/ui/Notice';
import { Select } from '@/components/ui/Select';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { StaticFieldValue } from '@/components/ui/StaticFieldValue';
import { Stack } from '@/components/layout/Stack';
import { useContent, type Content } from '@/lib/content';
import {
  isStatusFinal,
  isTerminalStatus,
  priorityOptions,
  statusMovesFor,
  type TerminalTicketStatus,
} from '@/features/tickets/presentation';
import { useTicketUpdate } from '@/features/tickets/useTicketUpdate';
import { LazyConfirmTicketStatusDialog } from './ticket-dialogs.lazy';
import styles from './TicketControls.module.css';

/**
 * Where a ticket's status and priority are changed. Usage:
 * `<TicketControls ticketId={…} label={…} status={…} priority={…} canUpdate canClose />`.
 *
 * The two controls are deliberately different shapes, because the two decisions
 * are:
 *
 *   * **Status is a row of verbs**, one per move `TICKET_STATUS_TRANSITIONS`
 *     allows out of the current status — so a `closed` ticket renders none, and
 *     nothing on screen can produce a `conflict` from the transition table. A
 *     move into `resolved` or `closed` is confirmed first; those are one-way.
 *   * **Priority is a select**, because it is a value rather than an act, it is
 *     freely reversible, and it applies straight away.
 *
 * `canUpdate` / `canClose` come from the server's permission check and only
 * decide what is rendered. The server action asserts the same permissions and the
 * API refuses the same call a third time.
 */

export interface TicketControlsProps {
  ticketId: string;
  /** The ticket's subject, or its number when it has none. */
  label: string;
  status: TicketStatus;
  priority: TicketPriority;
  canUpdate: boolean;
  /** Adds the `resolved` and `closed` moves; `ticket:close` (ADR 0006 §7). */
  canClose: boolean;
}

export function TicketControls({
  ticketId,
  label,
  status,
  priority,
  canUpdate,
  canClose,
}: TicketControlsProps) {
  const content = useContent();
  const statusLabelId = useId();
  const [confirming, setConfirming] = useState<TerminalTicketStatus | null>(null);
  const { apply, isPending, pendingPatch, formError, requestId } = useTicketUpdate(ticketId, () => {
    setConfirming(null);
  });

  const moves = canUpdate ? statusMovesFor(status, canClose) : [];

  return (
    <Stack gap="4">
      {canUpdate ? null : <Notice tone="info">{content.tickets.updateNotPermitted}</Notice>}

      {/* Outside the dialog as well: a priority change can fail with no dialog
          open to render its error in. */}
      {confirming === null ? <FormError message={formError} requestId={requestId} /> : null}

      <Stack gap="2">
        <p id={statusLabelId} className={styles.legend}>
          {content.tickets.statusLabel}
        </p>
        {moves.length === 0 ? (
          <StaticFieldValue>{content.ticketStatuses[status]}</StaticFieldValue>
        ) : (
          <div role="group" aria-labelledby={statusLabelId} className={styles.moves}>
            {moves.map((next) => (
              <Button
                key={next}
                // Only `resolved` is primary: it is the ending an agent is
                // working towards, and two green buttons side by side would
                // make "Close" — filing a wrong number — look equally expected.
                // Both are confirmed either way; the confirmation is the gate,
                // not the colour.
                variant={next === 'resolved' ? 'primary' : 'secondary'}
                size="sm"
                // The spinner marks the button that was pressed; the guard below
                // is what stops any *other* control starting a second patch.
                isPending={pendingPatch?.status === next}
                onClick={() => {
                  // One patch at a time. Both controls share a single hook, so a
                  // second one cannot be sent — and a control that quietly did
                  // nothing while reporting success is the bug this closes.
                  if (isPending) {
                    return;
                  }

                  if (isTerminalStatus(next)) {
                    setConfirming(next);
                    return;
                  }

                  apply({ status: next });
                }}
              >
                {content.tickets.statusActions[next]}
              </Button>
            ))}
          </div>
        )}
        <StatusHint content={content} status={status} canUpdate={canUpdate} canClose={canClose} />
      </Stack>

      <div className={styles.priority}>
        <Field label={content.tickets.priorityLabel}>
          {({ controlId }) =>
            canUpdate ? (
              <PrioritySelect
                controlId={controlId}
                priority={priority}
                // The *shared* pending flag, not this control's own patch: a
                // status change in flight must shut this select too, or the two
                // controls race for one hook.
                isPending={isPending}
                formError={formError}
                onSelect={(next) => apply({ priority: next })}
              />
            ) : (
              <StaticFieldValue id={controlId}>
                {content.ticketPriorities[priority]}
              </StaticFieldValue>
            )
          }
        </Field>
      </div>

      {/* The dialog chunk loads on first open, not with the page. */}
      {confirming === null ? null : (
        <LazyConfirmTicketStatusDialog
          status={confirming}
          label={label}
          isPending={isPending}
          formError={formError}
          requestId={requestId}
          onConfirm={() => {
            apply({ status: confirming });
          }}
          onClose={() => {
            setConfirming(null);
          }}
        />
      )}
    </Stack>
  );
}

/**
 * Why the status row is not offering what an agent expects, when it is not.
 *
 * Said rather than left as a missing button: a panel with no controls and no
 * explanation is the hardest kind of screen to debug from the other side of a
 * support call. The two cases are genuinely different — one is about the ticket
 * being finished, the other about the reader's role — so they get different copy.
 */
function StatusHint({
  content,
  status,
  canUpdate,
  canClose,
}: { content: Content } & Pick<TicketControlsProps, 'status' | 'canUpdate' | 'canClose'>) {
  if (!canUpdate) {
    return null;
  }

  if (isStatusFinal(status)) {
    return <p className={styles.hint}>{content.tickets.statusFinal}</p>;
  }

  if (canClose) {
    return null;
  }

  return <p className={styles.hint}>{content.tickets.closeNotPermitted}</p>;
}

/**
 * The priority picker, with the rollback an optimistic value owes.
 *
 * A native `<select>` shows the agent's choice the instant they make it, and a
 * value bound straight to the server's would snap back to the old one until the
 * response landed. So the choice is held locally *and* given up on every ending:
 * released when the server's value catches up, released on failure, and released
 * when the patch was never sent at all. All three are the same rule — the
 * control must never show a change the server does not hold.
 */
function PrioritySelect({
  controlId,
  priority,
  isPending,
  formError,
  onSelect,
}: {
  controlId: string;
  priority: TicketPriority;
  isPending: boolean;
  formError: string | null;
  /** Returns `false` when the patch was dropped rather than sent. */
  onSelect: (next: TicketPriority) => boolean;
}) {
  const [draft, setDraft] = useState<TicketPriority | null>(null);

  // The server's value has arrived; the draft has nothing left to say.
  useEffect(() => {
    setDraft(null);
  }, [priority]);

  // The rollback. Without it the control would keep showing a change the API
  // refused.
  useEffect(() => {
    if (formError !== null) {
      setDraft(null);
    }
  }, [formError]);

  return (
    <Select
      id={controlId}
      name="priority"
      value={draft ?? priority}
      options={priorityOptions()}
      disabled={isPending}
      onChange={(event) => {
        const next = event.target.value as TicketPriority;

        setDraft(next);

        // Dropped rather than sent — nothing is coming back to release the
        // draft, so it is released here instead of stranding the control on a
        // value the server never heard about.
        if (!onSelect(next)) {
          setDraft(null);
        }
      }}
    />
  );
}

/**
 * Mirrors `TicketControls`: the same status legend over a row of button-height
 * placeholders, and the same labelled priority field — so the swap to the real
 * controls moves nothing.
 *
 * Two placeholders, because that is what an active ticket renders for the
 * commonest principal. Reserving the row's height is what stops the panel
 * jumping; its exact width is not something the swap can shift.
 */
export function TicketControlsSkeleton() {
  const content = useContent();

  return (
    <Stack gap="4" aria-hidden="true">
      <Stack gap="2">
        <p className={styles.legend}>{content.tickets.statusLabel}</p>
        <div className={styles.moves}>
          <SkeletonLine width="9rem" height="var(--size-control-sm)" />
          <SkeletonLine width="6rem" height="var(--size-control-sm)" />
        </div>
      </Stack>
      <div className={styles.priority}>
        <Field label={content.tickets.priorityLabel}>
          {() => <SkeletonLine height="var(--size-control-md)" />}
        </Field>
      </div>
    </Stack>
  );
}
