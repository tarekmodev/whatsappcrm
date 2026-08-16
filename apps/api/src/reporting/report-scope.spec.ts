import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import { assignedFilter } from '../rbac/visibility';
import { reportScopeClause, resolveReportScope } from './report-scope';

/**
 * The one thing this file is really for: **the reporting statements aggregate
 * over exactly the set `GET /tickets` lists.**
 *
 * ADR 0004 calls the assigned-set rule the most re-implementable in the
 * codebase, and names the specific failure a second copy causes — "a report that
 * aggregates over a wider set than the list endpoint and becomes a read channel
 * around the matrix". This is that rule's first raw-SQL caller, so the
 * correspondence is asserted value by value rather than assumed from the two
 * bodies looking alike.
 */

const TENANT = '25777777-7777-7777-8777-777777777701';
const AGENT = '25777777-7777-7777-8777-7777777777d1';
const TEAM_A = '25777777-7777-7777-8777-7777777777b1';
const TEAM_B = '25777777-7777-7777-8777-7777777777b2';
const OTHER_TEAM = '25777777-7777-7777-8777-7777777777b9';

function principal(role: 'agent' | 'supervisor', teamIds: string[] = []): SessionPrincipal {
  return {
    tenantId: TENANT,
    userId: AGENT,
    email: 'rana@example.test',
    displayName: 'Rana',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds,
    sessionId: '25777777-7777-7777-8777-7777777777s1',
    expiresAt: '2026-08-16T09:00:00.000Z',
  };
}

describe('reportScopeClause', () => {
  it('binds exactly the values assignedFilter names, in the same order', () => {
    // The correspondence, asserted rather than eyeballed. `assignedFilter` is
    // the rule; this file changes its representation and must not change its
    // meaning. A branch added there and forgotten here fails right here.
    const caller = principal('agent', [TEAM_A, TEAM_B]);
    const [byUser, byTeam] = assignedFilter(caller).OR;

    const clause = reportScopeClause({ scope: 'assigned', assignedTeamId: undefined }, caller);

    expect(clause.values).toEqual([byUser.assignedUserId, ...byTeam.assignedTeamId.in]);
  });

  it('reads both of the two columns the rule is about, and no others', () => {
    const clause = reportScopeClause(
      { scope: 'assigned', assignedTeamId: undefined },
      principal('agent', [TEAM_A]),
    );

    expect(clause.sql).toContain('"assigned_user_id"');
    expect(clause.sql).toContain('"assigned_team_id"');
    // Attribution is deliberately absent: visibility reads *current* assignment,
    // and mixing the recorded-history columns into it would let an agent's own
    // past work drag a ticket they can no longer see into their report.
    expect(clause.sql).not.toContain('first_response_user_id');
    expect(clause.sql).not.toContain('resolved_by_user_id');
  });

  it('gives a teamless agent their own work and no team’s', () => {
    // `IN ()` is not valid SQL, so the team branch has to be something. `FALSE`
    // is the correct predicate rather than a fallback: they are in no team, so
    // no team's tickets are theirs.
    const clause = reportScopeClause(
      { scope: 'assigned', assignedTeamId: undefined },
      principal('agent'),
    );

    expect(clause.sql).toContain('FALSE');
    expect(clause.sql).not.toContain('IN ()');
    expect(clause.values).toEqual([AGENT]);
  });

  it('narrows an agent who asks for the whole tenant instead of refusing them', () => {
    // ADR 0004 invariant 2. A supervisor's dashboard URL opened by an agent
    // renders with less in it; it does not 403.
    const caller = principal('agent', [TEAM_A]);

    expect(resolveReportScope('all', caller)).toBe('assigned');
    expect(reportScopeClause({ scope: 'all', assignedTeamId: undefined }, caller).values).toEqual([
      AGENT,
      TEAM_A,
    ]);
  });

  it('adds no clause for a supervisor asking for the whole tenant', () => {
    const caller = principal('supervisor');

    expect(resolveReportScope('all', caller)).toBe('all');
    expect(reportScopeClause({ scope: 'all', assignedTeamId: undefined }, caller).values).toEqual(
      [],
    );
  });

  it('still scopes a supervisor who asks for their own work', () => {
    // The distinction `visibility.ts` draws: a *visibility* question answers
    // "everything" for a principal holding `_all`, but an explicit
    // `scope=assigned` is a filter the caller chose, and answering it with the
    // tenant's numbers would be the wrong report.
    const caller = principal('supervisor', [TEAM_A]);

    expect(
      reportScopeClause({ scope: 'assigned', assignedTeamId: undefined }, caller).values,
    ).toEqual([AGENT, TEAM_A]);
  });

  it('conjoins a team filter with the scope rather than replacing it', () => {
    // The failure this guards: a team filter that *replaced* the scope would let
    // an agent report on a team they are not in by naming it in the query
    // string. Both clauses are present and both are `AND`.
    const clause = reportScopeClause(
      { scope: 'assigned', assignedTeamId: OTHER_TEAM },
      principal('agent', [TEAM_A]),
    );

    expect(clause.values).toEqual([AGENT, TEAM_A, OTHER_TEAM]);
    expect(clause.sql.match(/AND/g)).toHaveLength(2);
  });

  it('applies a team filter on its own for a supervisor', () => {
    const clause = reportScopeClause(
      { scope: 'all', assignedTeamId: TEAM_B },
      principal('supervisor'),
    );

    expect(clause.values).toEqual([TEAM_B]);
    expect(clause.sql).toContain('"assigned_team_id"');
  });
});
