import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import { isVisible, isVisibleOrUnclaimed } from '../rbac/visibility';
import { inboxScopeFilter } from './inbox-scope';

/**
 * The shared inbox, from both sides: the predicate that decides whether one
 * conversation is visible, and the `where` fragment that decides which ones a
 * page contains. They have to agree — a queue that lists rows the detail route
 * then answers `not_found` for is worse than no queue at all — so the widening
 * is asserted here in one file.
 */

const TEAM = '68444444-4444-7444-8444-4444444444b1';
const OTHER_TEAM = '68444444-4444-7444-8444-4444444444b2';
const ME = '68444444-4444-7444-8444-4444444444a1';
const SOMEBODY_ELSE = '68444444-4444-7444-8444-4444444444a2';

function principal(role: 'agent' | 'supervisor', teamIds: string[] = []): SessionPrincipal {
  return {
    userId: ME,
    tenantId: '68444444-4444-7444-8444-444444444401',
    email: 'agent@example.invalid',
    displayName: 'Ada Agent',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds,
    sessionId: '68444444-4444-7444-8444-4444444444e1',
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

const AGENT = principal('agent', [TEAM]);
const SUPERVISOR = principal('supervisor');

describe('shared-inbox visibility', () => {
  it('shows an agent a conversation nobody has claimed', () => {
    const unclaimed = { assignedUserId: null, assignedTeamId: null };

    // The whole difference from `isVisible`, and the reason it is a separate
    // function: a conversation is created by a customer writing in, so an
    // unclaimed one would otherwise be visible to nobody at all.
    expect(isVisible(unclaimed, AGENT, 'conversation:read_all')).toBe(false);
    expect(isVisibleOrUnclaimed(unclaimed, AGENT, 'conversation:read_all')).toBe(true);
  });

  it('still hides a conversation another agent has claimed', () => {
    expect(
      isVisibleOrUnclaimed(
        { assignedUserId: SOMEBODY_ELSE, assignedTeamId: null },
        AGENT,
        'conversation:read_all',
      ),
    ).toBe(false);
  });

  it('still hides a conversation routed to a team the agent is not in', () => {
    expect(
      isVisibleOrUnclaimed(
        { assignedUserId: null, assignedTeamId: OTHER_TEAM },
        AGENT,
        'conversation:read_all',
      ),
    ).toBe(false);
  });

  it('shows a conversation routed to a team the agent is in', () => {
    expect(
      isVisibleOrUnclaimed(
        { assignedUserId: null, assignedTeamId: TEAM },
        AGENT,
        'conversation:read_all',
      ),
    ).toBe(true);
  });

  it('shows a supervisor everything, claimed or not', () => {
    expect(
      isVisibleOrUnclaimed(
        { assignedUserId: SOMEBODY_ELSE, assignedTeamId: OTHER_TEAM },
        SUPERVISOR,
        'conversation:read_all',
      ),
    ).toBe(true);
  });
});

describe('inboxScopeFilter', () => {
  it('scopes `assigned` to the caller and their teams', () => {
    expect(inboxScopeFilter('assigned', AGENT)).toEqual({
      OR: [{ assignedUserId: ME }, { assignedTeamId: { in: [TEAM] } }],
    });
  });

  it('scopes `assigned` to the caller even when they may read everything', () => {
    // The trap `visibilityFilter` sets: it answers `null` for a `_all` holder,
    // which as a *scope* would hand a supervisor the whole tenant when they
    // asked for their own work.
    expect(inboxScopeFilter('assigned', SUPERVISOR)).toEqual({
      OR: [{ assignedUserId: ME }, { assignedTeamId: { in: [] } }],
    });
  });

  it('opens `unassigned` to an agent — this is the shared pool', () => {
    expect(inboxScopeFilter('unassigned', AGENT)).toEqual({
      assignedUserId: null,
      assignedTeamId: null,
    });
  });

  it('narrows `all` to what an agent may see rather than rejecting it', () => {
    // A supervisor's shared inbox URL renders for an agent with less in it, and
    // the console shows a notice — the "narrow, never reject" rule.
    expect(inboxScopeFilter('all', AGENT)).toEqual({
      OR: [
        { assignedUserId: ME },
        { assignedTeamId: { in: [TEAM] } },
        { assignedUserId: null, assignedTeamId: null },
      ],
    });
  });

  it('puts no scope clause on `all` for a principal holding read_all', () => {
    expect(inboxScopeFilter('all', SUPERVISOR)).toBeNull();
  });
});
