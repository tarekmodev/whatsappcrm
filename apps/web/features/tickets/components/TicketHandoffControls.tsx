'use client';

import { useState } from 'react';
import type { UserResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { LazyEscalateTicketDialog, LazyReassignTicketDialog } from './handoff-dialogs.lazy';
import styles from './TicketHandoffControls.module.css';

/**
 * Where a ticket is handed on or escalated. Usage:
 * `<TicketHandoffControls ticketId={…} label={…} teammates={…} supervisors={…}
 *                         canReassign canEscalate />`.
 *
 * Two buttons and nothing else, because the two decisions are genuinely
 * different acts on the same ticket and each needs a reason the other does not
 * share:
 *
 *   * **Reassign** gives the work away. Somebody else holds it afterwards.
 *   * **Escalate** does not. The agent keeps the ticket and asks for attention,
 *     which is the whole point of ADR 0011 decision 3 — escalating must not be
 *     the button that loses your work.
 *
 * Each opens its own lazily-loaded dialog, and only one is ever open: the state
 * is a single discriminated value rather than two booleans, so "both open" is
 * not a state anybody has to reason about.
 *
 * `canReassign` / `canEscalate` come from the server's permission check and only
 * decide what is rendered. The server actions assert the same permissions and
 * the API refuses the same calls a third time.
 */

export type HandoffDialog = 'reassign' | 'escalate';

export interface TicketHandoffControlsProps {
  ticketId: string;
  /** The ticket's subject, or its number when it has none. */
  label: string;
  /** Who this principal may hand to; may be empty, and the dialog says so. */
  teammates: readonly UserResponse[];
  /** Who an escalation may name; may be empty, and the derived option still stands. */
  supervisors: readonly UserResponse[];
  /** `ticket:handoff` (ADR 0011 decision 2). */
  canReassign: boolean;
  /** `ticket:escalate` (ADR 0011 decision 3). */
  canEscalate: boolean;
}

export function TicketHandoffControls({
  ticketId,
  label,
  teammates,
  supervisors,
  canReassign,
  canEscalate,
}: TicketHandoffControlsProps) {
  const content = useContent();
  const [openDialog, setOpenDialog] = useState<HandoffDialog | null>(null);

  // Both permissions are in every role's set today, so this is the rare case —
  // a role that has had them taken away. Said rather than left as two missing
  // buttons: a card with no controls and no explanation reads as broken.
  if (!canReassign && !canEscalate) {
    return <Notice tone="info">{content.tickets.handoffNotPermitted}</Notice>;
  }

  const close = () => {
    setOpenDialog(null);
  };

  return (
    <Stack gap="3">
      <div className={styles.actions}>
        {canReassign ? (
          <Button
            variant="secondary"
            onClick={() => {
              setOpenDialog('reassign');
            }}
          >
            {content.tickets.reassign}
          </Button>
        ) : null}
        {canEscalate ? (
          <Button
            variant="secondary"
            onClick={() => {
              setOpenDialog('escalate');
            }}
          >
            {content.tickets.escalate}
          </Button>
        ) : null}
      </div>

      <p className={styles.hint}>{content.tickets.handoffDescription}</p>

      {/* The dialog chunks load on first open, not with the page. */}
      {openDialog === 'reassign' ? (
        <LazyReassignTicketDialog
          ticketId={ticketId}
          label={label}
          teammates={teammates}
          onClose={close}
        />
      ) : null}

      {openDialog === 'escalate' ? (
        <LazyEscalateTicketDialog
          ticketId={ticketId}
          label={label}
          supervisors={supervisors}
          onClose={close}
        />
      ) : null}
    </Stack>
  );
}

/**
 * Mirrors `TicketHandoffControls`: the same two button-height placeholders in
 * the same wrapping row, over the same line of explanation — so the swap to the
 * real controls moves nothing.
 *
 * The hint is rendered through `SkeletonForText` rather than as a fixed-width
 * line, because it is copy the skeleton actually knows: it wraps to two lines on
 * a phone and one on a laptop, and a guessed width would be wrong at one of them.
 */
export function TicketHandoffControlsSkeleton() {
  const content = useContent();

  return (
    <Stack gap="3" aria-hidden="true">
      <div className={styles.actions}>
        <SkeletonLine width="7rem" height="var(--size-control-md)" />
        <SkeletonLine width="7rem" height="var(--size-control-md)" />
      </div>
      <p className={styles.hint}>
        <SkeletonForText>{content.tickets.handoffDescription}</SkeletonForText>
      </p>
    </Stack>
  );
}
