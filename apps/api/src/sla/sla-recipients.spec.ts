import { resolveAlertRecipients, type AlertCandidate } from './sla-recipients';

/**
 * 0006 decision 4: who a breach is reported to.
 *
 * The rule matters more than it looks. Narrow it wrongly and a supervisor is
 * never told; widen it wrongly and every supervisor in the tenant is paged about
 * a ticket in a team they have nothing to do with. The one thing that must never
 * happen is the third case — an alert delivered to nobody — which is why the
 * fallback is broad rather than empty.
 */

const SUPERVISOR = 'supervisor';
const ADMIN = 'admin';
const TEAM_SALES = 'team-sales';
const TEAM_SUPPORT = 'team-support';
const AGENT = 'agent';

function candidate(id: string, ...teamIds: string[]): AlertCandidate {
  return { id, teamIds };
}

describe('resolveAlertRecipients', () => {
  /**
   * `last_admin_required` guarantees every tenant keeps one active admin, so
   * this is theoretical — but "nobody was told" must be an outcome the caller
   * can see rather than an empty loop nobody notices.
   */
  it('answers nobody when the tenant has no active supervisor or admin', () => {
    expect(
      resolveAlertRecipients([], {
        assignedUserId: AGENT,
        assignedTeamId: null,
        assignedUserTeamIds: [TEAM_SALES],
      }),
    ).toEqual([]);
  });

  it('narrows to the supervisors who share a team with the assigned agent', () => {
    const recipients = resolveAlertRecipients(
      [candidate(SUPERVISOR, TEAM_SALES), candidate(ADMIN, TEAM_SUPPORT)],
      { assignedUserId: AGENT, assignedTeamId: null, assignedUserTeamIds: [TEAM_SALES] },
    );

    expect(recipients).toEqual([SUPERVISOR]);
  });

  it('uses the assigned team when nobody personally holds the ticket', () => {
    const recipients = resolveAlertRecipients(
      [candidate(SUPERVISOR, TEAM_SALES), candidate(ADMIN, TEAM_SUPPORT)],
      { assignedUserId: null, assignedTeamId: TEAM_SUPPORT, assignedUserTeamIds: [] },
    );

    expect(recipients).toEqual([ADMIN]);
  });

  /**
   * The three fallback branches, all landing on the same answer: a broad alert
   * is worse than a narrow one, and an alert delivered to nobody is worse than
   * both.
   */
  it.each([
    [
      'the ticket is unassigned',
      { assignedUserId: null, assignedTeamId: null, assignedUserTeamIds: [] },
    ],
    [
      'the assigned agent is in no team',
      { assignedUserId: AGENT, assignedTeamId: null, assignedUserTeamIds: [] },
    ],
    [
      'no supervisor shares the assigned agent’s team',
      { assignedUserId: AGENT, assignedTeamId: null, assignedUserTeamIds: ['team-nobody-else'] },
    ],
  ])('falls back to every supervisor and admin when %s', (_case, responsibility) => {
    const recipients = resolveAlertRecipients(
      [candidate(SUPERVISOR, TEAM_SALES), candidate(ADMIN, TEAM_SUPPORT)],
      responsibility,
    );

    expect(recipients).toEqual([SUPERVISOR, ADMIN]);
  });

  /**
   * A supervisor working their own queue wants to know their own ticket
   * breached. Excluding them would buy nothing but a branch.
   */
  it('does not exclude the assignee when they are themselves a supervisor', () => {
    const recipients = resolveAlertRecipients([candidate(SUPERVISOR, TEAM_SALES)], {
      assignedUserId: SUPERVISOR,
      assignedTeamId: null,
      assignedUserTeamIds: [TEAM_SALES],
    });

    expect(recipients).toEqual([SUPERVISOR]);
  });

  it('reports a supervisor in several of the agent’s teams once', () => {
    const recipients = resolveAlertRecipients([candidate(SUPERVISOR, TEAM_SALES, TEAM_SUPPORT)], {
      assignedUserId: AGENT,
      assignedTeamId: null,
      assignedUserTeamIds: [TEAM_SALES, TEAM_SUPPORT],
    });

    expect(recipients).toEqual([SUPERVISOR]);
  });
});
