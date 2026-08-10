import { permissionsForRole, type SessionPrincipal, type TenantRole } from '@whatsappcrm/contracts';
import { isVisible, narrowScope, visibilityFilter } from './visibility';

const AGENT_ID = '0192f0ff-0000-7000-8000-00000000a001';
const OTHER_AGENT_ID = '0192f0ff-0000-7000-8000-00000000a002';
const BILLING_TEAM = '0192f0ff-0000-7000-8000-00000000b001';
const SUPPORT_TEAM = '0192f0ff-0000-7000-8000-00000000b002';

/**
 * TAR-22 AC1 and AC2 as unit tests: an agent sees their own and their teams'
 * conversations and nothing else, and a supervisor sees the tenant.
 *
 * `permissions` is materialised through `permissionsForRole` rather than
 * written out, so a principal here cannot hold a permission the matrix does not
 * actually grant — which is what makes these tests evidence about the shipped
 * table rather than about a fixture.
 */
function principal(role: TenantRole, teamIds: readonly string[] = []): SessionPrincipal {
  return {
    userId: AGENT_ID,
    tenantId: '0192f0ff-0000-7000-8000-0000000000b1',
    email: `${role}@example.invalid`,
    displayName: role,
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [...teamIds],
    sessionId: '0192f0ff-0000-7000-8000-0000000000ff',
    expiresAt: '2026-12-31T23:59:59.000Z',
  };
}

describe('the visibility predicate', () => {
  const mine = { assignedUserId: AGENT_ID, assignedTeamId: null };
  const myTeams = { assignedUserId: OTHER_AGENT_ID, assignedTeamId: BILLING_TEAM };
  const anotherTeams = { assignedUserId: OTHER_AGENT_ID, assignedTeamId: SUPPORT_TEAM };
  const unassigned = { assignedUserId: null, assignedTeamId: null };

  describe('an agent', () => {
    const agent = principal('agent', [BILLING_TEAM]);

    it('sees a conversation assigned to them', () => {
      expect(isVisible(mine, agent, 'conversation:read_all')).toBe(true);
    });

    // TAR-22 AC2. Without this the acceptance criterion is unsatisfiable: an
    // agent has no other route to a team-routed conversation.
    it('sees a conversation routed to a team they are in', () => {
      expect(isVisible(myTeams, agent, 'conversation:read_all')).toBe(true);
    });

    it('does not see another team’s conversation, or an unassigned one', () => {
      expect(isVisible(anotherTeams, agent, 'conversation:read_all')).toBe(false);
      expect(isVisible(unassigned, agent, 'conversation:read_all')).toBe(false);
    });

    it('loses team visibility the moment they leave the team', () => {
      expect(isVisible(myTeams, principal('agent', []), 'conversation:read_all')).toBe(false);
    });
  });

  describe('a supervisor and an admin', () => {
    it('see every record in the tenant, including unassigned ones', () => {
      for (const role of ['supervisor', 'admin'] as const) {
        const holder = principal(role);

        for (const record of [mine, myTeams, anotherTeams, unassigned]) {
          expect({ role, visible: isVisible(record, holder, 'conversation:read_all') }).toEqual({
            role,
            visible: true,
          });
        }
      }
    });
  });

  it('is applied per resource, so ticket and conversation scope cannot diverge', () => {
    // An agent holds neither `_all`; a role that held one and not the other
    // would be visible here rather than in whichever endpoint noticed first.
    const agent = principal('agent', [BILLING_TEAM]);

    expect(isVisible(anotherTeams, agent, 'ticket:read_all')).toBe(false);
    expect(isVisible(anotherTeams, principal('supervisor'), 'ticket:read_all')).toBe(true);
  });
});

describe('scope narrowing', () => {
  it('narrows rather than rejects, so a shared supervisor URL still renders', () => {
    const agent = principal('agent', [BILLING_TEAM]);

    expect(narrowScope('all', agent, 'conversation:read_all')).toBe('assigned');
    expect(narrowScope('unassigned', agent, 'conversation:read_all')).toBe('assigned');
  });

  it('leaves a supervisor’s requested scope alone', () => {
    const supervisor = principal('supervisor');

    expect(narrowScope('all', supervisor, 'conversation:read_all')).toBe('all');
    expect(narrowScope('unassigned', supervisor, 'conversation:read_all')).toBe('unassigned');
  });
});

describe('the query filter', () => {
  it('is the caller or any of their teams', () => {
    expect(
      visibilityFilter(principal('agent', [BILLING_TEAM, SUPPORT_TEAM]), 'conversation:read_all'),
    ).toEqual({
      OR: [{ assignedUserId: AGENT_ID }, { assignedTeamId: { in: [BILLING_TEAM, SUPPORT_TEAM] } }],
    });
  });

  it('is null — not an empty object — for a principal who needs no scoping', () => {
    // The distinction is what makes a forgotten spread a compile error rather
    // than a query that silently widened.
    expect(visibilityFilter(principal('supervisor'), 'conversation:read_all')).toBeNull();
  });

  it('still scopes a teamless agent to their own work rather than to nothing', () => {
    expect(visibilityFilter(principal('agent'), 'conversation:read_all')).toEqual({
      OR: [{ assignedUserId: AGENT_ID }, { assignedTeamId: { in: [] } }],
    });
  });

  it('agrees with the record-level predicate on the same records', () => {
    // The two are used in different places — one filters a list in SQL, the
    // other authorises a single record in memory — and a disagreement between
    // them is a record a caller can open but not find, or worse.
    const agent = principal('agent', [BILLING_TEAM]);
    const filter = visibilityFilter(agent, 'conversation:read_all');

    const matches = (record: { assignedUserId: string | null; assignedTeamId: string | null }) =>
      filter !== null &&
      (record.assignedUserId === filter.OR[0].assignedUserId ||
        (record.assignedTeamId !== null &&
          filter.OR[1].assignedTeamId.in.includes(record.assignedTeamId)));

    for (const record of [
      { assignedUserId: AGENT_ID, assignedTeamId: null },
      { assignedUserId: OTHER_AGENT_ID, assignedTeamId: BILLING_TEAM },
      { assignedUserId: OTHER_AGENT_ID, assignedTeamId: SUPPORT_TEAM },
      { assignedUserId: null, assignedTeamId: null },
    ]) {
      expect(matches(record)).toBe(isVisible(record, agent, 'conversation:read_all'));
    }
  });
});
