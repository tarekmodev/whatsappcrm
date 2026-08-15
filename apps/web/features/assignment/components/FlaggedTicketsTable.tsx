'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { UserResponse } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Cluster } from '@/components/layout/Cluster';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import type { FlaggedTicketRow } from '../flagged-rows';
import { ticketLabel } from '../ticket-label';
import { DEFERRED_REASON_TONES } from '../presentation';
import { flaggedTicketColumnMeta } from './flagged-columns';
import { LazyAssignFlaggedTicketDialog } from './flagged-dialogs.lazy';
import styles from './FlaggedTicketsTable.module.css';

/**
 * Tickets auto-assignment could not place, and the control that takes one off the
 * list. Usage:
 * `<FlaggedTicketsTable rows={rows} assignableUsers={users} canAssign isFiltered />`.
 *
 * A client component because the row action opens a dialog; the data is fetched on
 * the server and passed in, so no client-side waterfall is introduced. Reuses
 * `DataTable`, so the stacked-card layout below the breakpoint and the header
 * semantics are shared with every other table in the app.
 *
 * Each row answers the two questions ADR 0008 says a supervisor is actually
 * asking: *why* is this stuck, and *how long* has it been. The reason is a badge
 * plus a sentence naming who can fix it — "at capacity" and "nobody available"
 * need different people to act, and a queue that merged them would send somebody
 * hunting for colleagues who were never configured.
 */

export interface FlaggedTicketsTableProps {
  rows: readonly FlaggedTicketRow[];
  /** Active agents offered in the assign dialog. Empty is a rendered state, not a crash. */
  assignableUsers: readonly UserResponse[];
  /** From the server's `ticket:assign` check. The action asserts it again. */
  canAssign: boolean;
  /** Changes the empty copy: "nothing is stuck" and "nothing matches" are different news. */
  isFiltered: boolean;
}

export function FlaggedTicketsTable({
  rows,
  assignableUsers,
  canAssign,
  isFiltered,
}: FlaggedTicketsTableProps) {
  const content = useContent();
  const [assigning, setAssigning] = useState<FlaggedTicketRow | null>(null);

  const columns = useMemo<DataTableColumn<FlaggedTicketRow>[]>(() => {
    const renderers: Record<string, (row: FlaggedTicketRow) => ReactNode> = {
      ticket: (row) => (
        <Stack gap="1">
          <span className={styles.subject}>{ticketLabel(row.ticket, content)}</span>
          <span className={styles.ticketMeta}>
            {content.assignment.ticketNumber(row.ticket.number)}
            {' · '}
            {row.routedToTeamName === null
              ? content.assignment.routedToNobody
              : content.assignment.routedToTeam(row.routedToTeamName)}
          </span>
        </Stack>
      ),
      // The badge names the state and the hint names the person who can end it.
      // Colour alone never carries either.
      reason: (row) => (
        <Stack gap="1" className={styles.reasonCell}>
          <Badge tone={DEFERRED_REASON_TONES[row.reason]}>
            {content.assignment.deferredReasons[row.reason]}
          </Badge>
          <span className={styles.reasonHint}>
            {content.assignment.deferredReasonHints[row.reason]}
          </span>
        </Stack>
      ),
      waiting: (row) => (
        <RelativeTime
          isoTimestamp={row.flaggedSince}
          label={content.assignment.waitingSinceLabel}
        />
      ),
      // A real button, always visible: a hover-only row action is unreachable by
      // touch and by keyboard.
      assign: (row) => (
        <Cluster gap="1" justify="end" className={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            // The ticket is in the accessible name, not only in the row beside
            // it: a column of buttons all called "Assign" tells a screen-reader
            // user nothing about which one they are about to place.
            aria-label={content.assignment.assignTicketAria(ticketLabel(row.ticket, content))}
            onClick={() => {
              setAssigning(row);
            }}
          >
            {content.assignment.assignTicket}
          </Button>
        </Cluster>
      ),
    };

    return flaggedTicketColumnMeta(content, canAssign).map((meta) => ({
      ...meta,
      render: renderers[meta.key] ?? (() => null),
    }));
  }, [canAssign, content]);

  if (rows.length === 0) {
    return (
      <EmptyState
        heading={
          isFiltered
            ? content.assignment.flaggedFilteredEmptyHeading
            : content.assignment.flaggedEmptyHeading
        }
        body={
          isFiltered
            ? content.assignment.flaggedFilteredEmptyBody
            : content.assignment.flaggedEmptyBody
        }
      />
    );
  }

  return (
    <>
      <DataTable
        caption={content.assignment.flaggedHeading}
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.ticket.id}
      />

      {/* The dialog's chunk loads on first open, not with the page. */}
      {assigning === null ? null : (
        <LazyAssignFlaggedTicketDialog
          row={assigning}
          assignableUsers={assignableUsers}
          onClose={() => {
            setAssigning(null);
          }}
        />
      )}
    </>
  );
}
