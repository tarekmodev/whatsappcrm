'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { UserResponse } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RowActions, type RowAction } from '@/components/ui/RowActions';
import { Stack } from '@/components/layout/Stack';
import { TextLink } from '@/components/ui/TextLink';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import type { AgentCapacityReport } from '../capacity';
import type { FlaggedTicketRow } from '../flagged-rows';
import { ticketLabel } from '../ticket-label';
import { DEFERRED_REASON_TONES } from '../presentation';
import { flaggedTicketColumnMeta } from './flagged-columns';
import { LazyAgentCapacityDialog, LazyAssignFlaggedTicketDialog } from './flagged-dialogs.lazy';
import styles from './FlaggedTicketsTable.module.css';

/**
 * Tickets auto-assignment could not place, and the control that takes one off the
 * list. Usage:
 * `<FlaggedTicketsTable rows={rows} assignableUsers={users} canAssign capacity={report} isFiltered />`.
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
 *
 * A row's actions follow from its reason. Assigning takes any ticket off the
 * list, so it is offered on every row; editing an agent's limit is only an answer
 * to `all_at_capacity`, so it is offered there and nowhere else — on a row that
 * says nobody was ever configured, raising a limit changes nothing (TAR-384).
 */

export interface FlaggedTicketsTableProps {
  rows: readonly FlaggedTicketRow[];
  /** Active agents offered in the assign dialog. Empty is a rendered state, not a crash. */
  assignableUsers: readonly UserResponse[];
  /** From the server's `ticket:assign` check. The action asserts it again. */
  canAssign: boolean;
  /**
   * Rotation candidates and their limits, or `null` when the cap-edit control
   * cannot be offered — the caller lacks `assignment_rule:write`, or the API does
   * not publish capacity. `null` is the whole gate: there is no second flag to
   * keep in step with it.
   */
  capacity: AgentCapacityReport | null;
  /** Changes the empty copy: "nothing is stuck" and "nothing matches" are different news. */
  isFiltered: boolean;
}

export function FlaggedTicketsTable({
  rows,
  assignableUsers,
  canAssign,
  capacity,
  isFiltered,
}: FlaggedTicketsTableProps) {
  const content = useContent();
  const [assigning, setAssigning] = useState<FlaggedTicketRow | null>(null);
  const [isEditingCapacity, setIsEditingCapacity] = useState(false);

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
      // Real buttons, always visible: a hover-only row action is unreachable by
      // touch and by keyboard. `RowActions` carries the app's weight ladder and
      // keeps the keyboard somewhere sensible when a row leaves the queue.
      assign: (row) => {
        const label = ticketLabel(row.ticket, content);
        const actions: RowAction[] = [];

        if (canAssign) {
          actions.push({
            key: 'assign',
            label: content.assignment.assignTicket,
            // The ticket is in the accessible name, not only in the row beside
            // it: a column of buttons all called "Assign" tells a screen-reader
            // user nothing about which one they are about to place.
            accessibleName: content.assignment.assignTicketAria(label),
            onSelect: () => {
              setAssigning(row);
            },
          });
        }

        if (capacity !== null && row.reason === 'all_at_capacity') {
          actions.push({
            key: 'capacity',
            label: content.assignment.editCapacity,
            accessibleName: content.assignment.editCapacityAria(label),
            onSelect: () => {
              setIsEditingCapacity(true);
            },
          });
        }

        return <RowActions subject={label} actions={actions} />;
      },
    };

    return flaggedTicketColumnMeta(content, canAssign || capacity !== null).map((meta) => ({
      ...meta,
      render: renderers[meta.key] ?? (() => null),
    }));
  }, [canAssign, capacity, content]);

  if (rows.length === 0) {
    // The filtered state offers to widen; the unfiltered one is good news and
    // has nothing to offer beyond saying so.
    return isFiltered ? (
      <EmptyState
        icon="filter"
        title={content.assignment.flaggedFilteredEmptyHeading}
        description={content.assignment.flaggedFilteredEmptyBody}
        action={
          <TextLink href={routes.settingsAssignment()}>
            {content.assignment.flaggedFilteredEmptyAction}
          </TextLink>
        }
      />
    ) : (
      <EmptyState
        icon="alert"
        title={content.assignment.flaggedEmptyHeading}
        description={content.assignment.flaggedEmptyBody}
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

      {/* Each dialog's chunk loads on first open, not with the page. */}
      {assigning === null ? null : (
        <LazyAssignFlaggedTicketDialog
          row={assigning}
          assignableUsers={assignableUsers}
          onClose={() => {
            setAssigning(null);
          }}
        />
      )}

      {/* One dialog for the table rather than one per row: it edits an *agent's*
          limit, not the ticket's, so which row opened it changes nothing about
          what it shows. */}
      {capacity === null || !isEditingCapacity ? null : (
        <LazyAgentCapacityDialog
          rows={capacity.rows}
          workspaceDefault={capacity.workspaceDefault}
          hasMore={capacity.hasMore}
          onClose={() => {
            setIsEditingCapacity(false);
          }}
        />
      )}
    </>
  );
}
