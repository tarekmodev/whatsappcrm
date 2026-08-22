import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TeamResponse, TicketResponse, UserResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { toFlaggedTicketRows } from '../flagged-rows';
import { FlaggedTicketsTable } from './FlaggedTicketsTable';
import { FlaggedTicketsTableSkeleton } from './FlaggedTicketsTable.Skeleton';

/**
 * TAR-23's second acceptance criterion at the row level: a supervisor can see
 * *which* tickets are stuck, *why* each one is, and act on one from here.
 */

const TEAMS: TeamResponse[] = [
  {
    id: '0192f002-0000-7000-8000-000000000201',
    name: 'Billing',
    description: null,
    memberUserIds: [],
    createdAt: '2026-07-02T10:10:00.000Z',
  },
];

const USERS: UserResponse[] = [
  {
    id: '0192f001-0000-7000-8000-000000000101',
    email: 'amina@northwind.example',
    displayName: 'Amina Haddad',
    avatarUrl: null,
    role: 'agent',
    status: 'active',
    availability: 'available',
    teamIds: [],
    occupiesSeat: true,
    lastSeenAt: null,
    security: null,
    assignmentCapacity: null,
    createdAt: '2026-07-02T10:00:00.000Z',
  },
];

function ticket(overrides: Partial<TicketResponse> = {}): TicketResponse {
  return {
    id: '0192f00a-0000-7000-8000-000000000a01',
    number: 1041,
    conversationId: null,
    contactId: null,
    subject: 'Refund still not showing on the card',
    status: 'open',
    priority: 'normal',
    assignedUserId: null,
    assignedTeamId: TEAMS[0]?.id ?? null,
    routing: {
      state: 'deferred',
      deferredReason: 'all_at_capacity',
      deferredSince: '2026-08-10T07:12:00.000Z',
    },
    sla: {
      policyId: null,
      firstResponseState: 'not_applicable',
      firstResponseDueAt: null,
      resolutionState: 'not_applicable',
      resolutionDueAt: null,
    },
    firstRespondedAt: null,
    resolvedAt: null,
    closedAt: null,
    createdAt: '2026-08-10T07:10:00.000Z',
    updatedAt: '2026-08-10T07:12:00.000Z',
    ...overrides,
  };
}

const ROWS = toFlaggedTicketRows([ticket()], TEAMS);

describe('FlaggedTicketsTable', () => {
  it('says why a ticket is unassigned, in words and not only in colour', () => {
    render(
      <FlaggedTicketsTable rows={ROWS} assignableUsers={USERS} canAssign isFiltered={false} />,
    );

    expect(
      screen.getByText(content.assignment.deferredReasons.all_at_capacity),
    ).toBeInTheDocument();
    expect(
      screen.getByText(content.assignment.deferredReasonHints.all_at_capacity),
    ).toBeInTheDocument();
  });

  it('distinguishes the three reasons rather than merging them into "unassigned"', () => {
    const rows = toFlaggedTicketRows(
      [
        ticket({ id: 'a', number: 1, routing: { ...ticket().routing } }),
        ticket({
          id: 'b',
          number: 2,
          routing: { ...ticket().routing, deferredReason: 'none_available' },
        }),
        ticket({
          id: 'c',
          number: 3,
          routing: { ...ticket().routing, deferredReason: 'no_candidate_pool' },
        }),
      ],
      TEAMS,
    );

    render(
      <FlaggedTicketsTable rows={rows} assignableUsers={USERS} canAssign isFiltered={false} />,
    );

    expect(
      screen.getByText(content.assignment.deferredReasons.all_at_capacity),
    ).toBeInTheDocument();
    expect(screen.getByText(content.assignment.deferredReasons.none_available)).toBeInTheDocument();
    expect(
      screen.getByText(content.assignment.deferredReasons.no_candidate_pool),
    ).toBeInTheDocument();
  });

  it('shows the team routing tried and how long the ticket has waited', () => {
    render(
      <FlaggedTicketsTable rows={ROWS} assignableUsers={USERS} canAssign isFiltered={false} />,
    );

    expect(
      screen.getByText(content.assignment.routedToTeam('Billing'), { exact: false }),
    ).toBeInTheDocument();
    // Server-stable absolute value until the client upgrades it after mount.
    expect(screen.getByRole('time')).toHaveAttribute('datetime', '2026-08-10T07:12:00.000Z');
  });

  it('reads a ticket with no team as the whole-workspace pool', () => {
    const rows = toFlaggedTicketRows([ticket({ assignedTeamId: null })], TEAMS);

    render(
      <FlaggedTicketsTable rows={rows} assignableUsers={USERS} canAssign isFiltered={false} />,
    );

    expect(
      screen.getByText(content.assignment.routedToNobody, { exact: false }),
    ).toBeInTheDocument();
  });

  it('falls back to the ticket number when there is no subject to show', () => {
    const rows = toFlaggedTicketRows([ticket({ subject: null, number: 1043 })], TEAMS);

    render(
      <FlaggedTicketsTable rows={rows} assignableUsers={USERS} canAssign isFiltered={false} />,
    );

    expect(screen.getByText(content.assignment.untitledTicket(1043))).toBeInTheDocument();
  });

  it('names the assign action after the ticket it acts on', () => {
    render(
      <FlaggedTicketsTable rows={ROWS} assignableUsers={USERS} canAssign isFiltered={false} />,
    );

    expect(
      screen.getByRole('button', {
        name: content.assignment.assignTicketAria('Refund still not showing on the card'),
      }),
    ).toBeInTheDocument();
  });

  it('renders no assign control, and no column for one, without the permission', () => {
    render(
      <FlaggedTicketsTable
        rows={ROWS}
        assignableUsers={USERS}
        canAssign={false}
        isFiltered={false}
      />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(3);
  });

  it('explains an empty queue as good news rather than rendering a blank panel', () => {
    render(<FlaggedTicketsTable rows={[]} assignableUsers={USERS} canAssign isFiltered={false} />);

    expect(screen.getByText(content.assignment.flaggedEmptyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.assignment.flaggedEmptyBody)).toBeInTheDocument();
  });

  it('says the filter is what emptied the list when one is applied', () => {
    render(<FlaggedTicketsTable rows={[]} assignableUsers={USERS} canAssign isFiltered />);

    expect(screen.getByText(content.assignment.flaggedFilteredEmptyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.assignment.flaggedFilteredEmptyBody)).toBeInTheDocument();
  });
});

describe('FlaggedTicketsTableSkeleton', () => {
  it('announces the load exactly once, politely', () => {
    render(<FlaggedTicketsTableSkeleton />);

    const announcements = screen.getAllByRole('status');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveTextContent(content.assignment.flaggedLoading);
  });

  it('mirrors the loaded table’s column set, so the swap shifts nothing', () => {
    const { unmount } = render(
      <FlaggedTicketsTable rows={ROWS} assignableUsers={USERS} canAssign isFiltered={false} />,
    );
    const loadedColumnCount = screen.getAllByRole('columnheader').length;

    unmount();

    render(<FlaggedTicketsTableSkeleton canAssign />);

    expect(document.querySelectorAll('th')).toHaveLength(loadedColumnCount);
  });

  it('drops the assign column when the role would not get one', () => {
    render(<FlaggedTicketsTableSkeleton canAssign={false} />);

    expect(document.querySelectorAll('th')).toHaveLength(3);
  });
});
