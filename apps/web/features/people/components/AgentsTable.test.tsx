import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TeamResponse, UserResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { AgentsTable, AgentsTableSkeleton } from './AgentsTable';

/**
 * TAR-82's last acceptance criterion at the row level: a role without the write
 * permissions is rendered no route to a tenant-admin action at all — not a disabled
 * button, not a hidden-by-CSS one.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/people',
}));

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
    teamIds: [TEAMS[0]?.id ?? ''],
    occupiesSeat: true,
    lastSeenAt: null,
    createdAt: '2026-07-02T10:00:00.000Z',
  },
];

describe('AgentsTable', () => {
  it('renders each agent with their role, teams, status and availability', () => {
    render(<AgentsTable users={USERS} teams={TEAMS} canEdit canRemove />);

    expect(screen.getByText('Amina Haddad')).toBeInTheDocument();
    expect(screen.getByText('amina@northwind.example')).toBeInTheDocument();
    expect(screen.getByText(content.roles.agent)).toBeInTheDocument();
    expect(screen.getByText('Billing')).toBeInTheDocument();
    expect(screen.getByText(content.userStatuses.active)).toBeInTheDocument();
    expect(screen.getByText(content.availability.available)).toBeInTheDocument();
  });

  it('names each row action after the agent it acts on', () => {
    render(<AgentsTable users={USERS} teams={TEAMS} canEdit canRemove />);

    expect(
      screen.getByRole('button', { name: content.people.editAgentAria('Amina Haddad') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.people.removeAgentAria('Amina Haddad') }),
    ).toBeInTheDocument();
  });

  it('renders no edit or remove control for a role that holds neither permission', () => {
    render(<AgentsTable users={USERS} teams={TEAMS} canEdit={false} canRemove={false} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // The whole column is gone, not just its buttons.
    expect(
      screen.queryByRole('columnheader', { name: content.people.columnActions }),
    ).not.toBeInTheDocument();
  });

  it('renders only the permitted action when a role holds one but not the other', () => {
    render(<AgentsTable users={USERS} teams={TEAMS} canEdit={false} canRemove />);

    expect(
      screen.queryByRole('button', { name: content.people.editAgentAria('Amina Haddad') }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.people.removeAgentAria('Amina Haddad') }),
    ).toBeInTheDocument();
  });

  it('explains an empty list rather than rendering a blank panel', () => {
    render(<AgentsTable users={[]} teams={TEAMS} canEdit canRemove />);

    expect(screen.getByText(content.people.agentsEmptyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.people.agentsEmptyBody)).toBeInTheDocument();
  });

  it('ignores a team id that no longer resolves instead of rendering a raw uuid', () => {
    render(<AgentsTable users={USERS} teams={[]} canEdit canRemove />);

    expect(screen.getByText(content.people.noTeams)).toBeInTheDocument();
    expect(screen.queryByText(TEAMS[0]?.id ?? '')).not.toBeInTheDocument();
  });
});

describe('AgentsTableSkeleton', () => {
  it('announces the load exactly once, politely', () => {
    render(<AgentsTableSkeleton />);

    const announcements = screen.getAllByRole('status');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveTextContent(content.people.agentsLoading);
  });

  it('mirrors the loaded table’s column set, including the actions column', () => {
    const { unmount } = render(<AgentsTable users={USERS} teams={TEAMS} canEdit canRemove />);
    const loadedColumnCount = screen.getAllByRole('columnheader').length;

    unmount();

    render(<AgentsTableSkeleton hasActions />);

    expect(document.querySelectorAll('th')).toHaveLength(loadedColumnCount);
  });

  it('drops the actions column when the role would not get one', () => {
    render(<AgentsTableSkeleton hasActions={false} />);

    // Five data columns, no actions column — matching what that role's real table
    // will render, so the swap does not shift.
    expect(document.querySelectorAll('th')).toHaveLength(5);
  });
});
