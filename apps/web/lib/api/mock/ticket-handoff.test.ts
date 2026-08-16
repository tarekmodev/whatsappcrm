import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CursorPage,
  TenantRole,
  TicketEscalationResponse,
  TicketEvent,
  TicketResponse,
} from '@whatsappcrm/contracts';

/**
 * The reassignment and escalation half of the mock transport (TAR-32,
 * ADR 0011).
 *
 * A file of its own rather than more cases in `handlers.test.ts`, which is
 * already 1,400 lines: these exercise one feature's three routes and the four
 * rules the console's claims rest on — the conditional reason, the handoff
 * bound, the escalation that does *not* move the assignment, and tenant scoping
 * on the trail.
 *
 * This is deliberately not the same thing as TAR-471's suite. It asserts that
 * the *fixture layer* the console is built against behaves like the contract, so
 * the UI is exercised against realistic refusals. The real endpoints are
 * TAR-469's, and QA verifies those.
 *
 * `server-only` throws outside a React Server Component, and `next/headers`
 * needs a request scope — both are stubbed so these stay plain unit tests.
 */

vi.mock('server-only', () => ({}));

let currentRole: TenantRole = 'admin';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'wac_role_stub' ? { name, value: currentRole } : undefined),
    }),
}));

const { handleMockRequest } = await import('./handlers');
const { resetMockState } = await import('./store');
const { MOCK_IDS } = await import('./fixtures');
const { ApiRequestError } = await import('@/lib/api/http');

function asRole(role: TenantRole): void {
  currentRole = role;
}

/** Amina's ticket: held by her, routed to Billing, and the one with a history. */
const HELD_TICKET = MOCK_IDS.tickets.fatimaUrgent;
/** Held by nobody at all, which is the asymmetry decision 1 is built on. */
const UNHELD_TICKET = MOCK_IDS.tickets.meiUnassigned;
/**
 * Routed to Billing and held by no *person*.
 *
 * Amina is in Billing, so it is visible to her — which is what makes it the
 * right ticket for the "reassigning something you do not hold" case. Using an
 * unassigned ticket there would answer `not_found` before the bound was reached,
 * because an unassigned ticket needs `ticket:read_all` to see at all.
 */
const COLLEAGUES_TICKET = MOCK_IDS.tickets.jonasPending;

const AMINA = MOCK_IDS.users.amina;
const PRIYA = MOCK_IDS.users.priya;
const LIANG = MOCK_IDS.users.liang;
const NOOR = MOCK_IDS.users.noor;

function assign(ticketId: string, body: unknown): Promise<unknown> {
  return handleMockRequest({ method: 'POST', path: `/v1/tickets/${ticketId}/assign`, body });
}

function escalate(ticketId: string, body: unknown): Promise<unknown> {
  return handleMockRequest({ method: 'POST', path: `/v1/tickets/${ticketId}/escalate`, body });
}

function events(ticketId: string): Promise<unknown> {
  return handleMockRequest({ method: 'GET', path: `/v1/tickets/${ticketId}/events?limit=50` });
}

beforeEach(() => {
  resetMockState();
  asRole('admin');
});

describe('reassignment — the conditional reason (ADR 0011 decision 1)', () => {
  it('refuses a reasonless move on a ticket somebody already holds', async () => {
    const attempt = assign(HELD_TICKET, { userId: LIANG });

    await expect(attempt).rejects.toBeInstanceOf(ApiRequestError);
    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('accepts a reasonless placement of a ticket nobody holds — the asymmetry is the design', async () => {
    const ticket = (await assign(UNHELD_TICKET, { userId: LIANG })) as TicketResponse;

    expect(ticket.assignedUserId).toBe(LIANG);
  });

  it('refuses whitespace, because it is not a reason', async () => {
    // The floor lives on the contract's own schema (`trim().min(3)`), so a body
    // that would log nothing is refused before the handler is reached.
    const attempt = assign(HELD_TICKET, { userId: LIANG, reason: '   ' });

    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('records the reason on the event log where the history can read it', async () => {
    await assign(HELD_TICKET, { userId: LIANG, reason: 'Handing over at end of shift.' });

    const page = (await events(HELD_TICKET)) as CursorPage<TicketEvent>;
    const [newest] = page.items;

    expect(newest?.type).toBe('assigned');
    expect(newest?.reason).toBe('Handing over at end of shift.');
    expect(newest?.actorUserId).toBe(MOCK_IDS.users.omar);
    // Both sides, which is what makes "from Amina to Liang" renderable at all.
    expect(newest?.assignment).toMatchObject({ fromUserId: AMINA, toUserId: LIANG });
  });
});

describe('reassignment — the handoff bound (ADR 0011 decision 2)', () => {
  it('lets an agent hand on the ticket they hold, to a teammate', async () => {
    asRole('agent');

    // Amina holds it, and Priya shares Billing with her.
    const ticket = (await assign(HELD_TICKET, {
      userId: PRIYA,
      reason: 'Needs a supervisor decision on the refund.',
    })) as TicketResponse;

    expect(ticket.assignedUserId).toBe(PRIYA);
  });

  it('refuses an agent reassigning a ticket they do not hold — forbidden, not not_found', async () => {
    asRole('agent');

    // Visible to Amina through her Billing membership, but held by no person —
    // so it is not hers to give away.
    const attempt = assign(COLLEAGUES_TICKET, {
      userId: PRIYA,
      reason: 'Picking this up for the team.',
    });

    // 403 rather than 404: the caller has passed the visibility rule and is
    // looking at the ticket, so what is refused is the act.
    await expect(attempt).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('refuses an agent handing to somebody they share no team with', async () => {
    asRole('agent');

    // Noor is in no team of Amina's.
    const attempt = assign(HELD_TICKET, { userId: NOOR, reason: 'Passing this along.' });

    await expect(attempt).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lets an agent drop the user half while their team keeps the ticket', async () => {
    asRole('agent');

    // Not a release: Billing still holds it, so somebody is still on it. The
    // bound is about leaving the ticket with nobody, not about clearing a column.
    const ticket = (await assign(HELD_TICKET, {
      userId: null,
      reason: 'Back to the Billing pool, I am off shift.',
    })) as TicketResponse;

    expect(ticket.assignedUserId).toBeNull();
    expect(ticket.assignedTeamId).not.toBeNull();
  });

  it('refuses an agent releasing a ticket outright, and allows a supervisor the same write', async () => {
    asRole('agent');

    await expect(
      assign(HELD_TICKET, { userId: null, teamId: null, reason: 'I cannot take this one.' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    asRole('supervisor');

    const ticket = (await assign(HELD_TICKET, {
      userId: null,
      teamId: null,
      reason: 'Parking it until Billing is staffed.',
    })) as TicketResponse;

    expect(ticket.assignedUserId).toBeNull();
  });
});

describe('escalation (ADR 0011 decision 3)', () => {
  it('does not move the assignment', async () => {
    const before = (await handleMockRequest({
      method: 'GET',
      path: `/v1/tickets/${HELD_TICKET}`,
    })) as TicketResponse;

    await escalate(HELD_TICKET, { reason: 'Customer is threatening a chargeback.' });

    const after = (await handleMockRequest({
      method: 'GET',
      path: `/v1/tickets/${HELD_TICKET}`,
    })) as TicketResponse;

    expect(after.assignedUserId).toBe(before.assignedUserId);
    expect(after.assignedTeamId).toBe(before.assignedTeamId);
  });

  it('requires a reason unconditionally', async () => {
    await expect(escalate(HELD_TICKET, {})).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('writes an escalated event and names who was told', async () => {
    const result = (await escalate(HELD_TICKET, {
      reason: 'Needs a refund decision today.',
    })) as TicketEscalationResponse;

    expect(result.event.type).toBe('escalated');
    expect(result.event.reason).toBe('Needs a refund decision today.');
    // Derived rather than named: `toValue` stays null, which is what says the
    // escalation went to whoever covers the ticket rather than to a person.
    expect(result.event.toValue).toBeNull();
    expect(result.notifiedUserIds.length).toBeGreaterThan(0);
  });

  it('carries the named supervisor on toValue and tells only them', async () => {
    const result = (await escalate(HELD_TICKET, {
      reason: 'Priya has the history on this account.',
      toUserId: PRIYA,
    })) as TicketEscalationResponse;

    expect(result.event.toValue).toBe(PRIYA);
    expect(result.notifiedUserIds).toEqual([PRIYA]);
  });

  it('refuses a named recipient who cannot read every ticket', async () => {
    // Liang is an agent: no `ticket:read_all`, so telling him would disclose
    // something he cannot already see.
    const attempt = escalate(HELD_TICKET, { reason: 'Asking Liang to look.', toUserId: LIANG });

    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a recipient from another tenant on the field, never with a 404', async () => {
    const attempt = escalate(HELD_TICKET, {
      reason: 'Cross-tenant escalation attempt.',
      toUserId: MOCK_IDS.users.otherTenant,
    });

    // `validation_failed`, not `not_found`: a 404 would confirm the id names
    // somebody real in another tenant.
    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('allows re-escalation — a second ask after silence is legitimate', async () => {
    await escalate(HELD_TICKET, { reason: 'First ask, nothing back yet.' });
    await escalate(HELD_TICKET, { reason: 'Second ask an hour later.' });

    const page = (await events(HELD_TICKET)) as CursorPage<TicketEvent>;

    expect(page.items.filter((event) => event.type === 'escalated').length).toBeGreaterThanOrEqual(
      2,
    );
  });
});

describe('the event log', () => {
  it('answers newest first', async () => {
    const page = (await events(HELD_TICKET)) as CursorPage<TicketEvent>;
    const timestamps = page.items.map((event) => event.createdAt);

    expect([...timestamps].sort((left, right) => right.localeCompare(left))).toEqual(timestamps);
  });

  it('never returns another tenant’s events', async () => {
    const page = (await events(HELD_TICKET)) as CursorPage<TicketEvent>;

    expect(page.items.map((event) => event.id)).not.toContain(MOCK_IDS.ticketEvents.otherTenant);

    for (const event of page.items) {
      expect(event).not.toHaveProperty('tenantId');
    }
  });

  it('answers not_found for a ticket in another tenant, not forbidden', async () => {
    const attempt = events(MOCK_IDS.tickets.otherTenant);

    await expect(attempt).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('answers not_found for a ticket an agent may not see', async () => {
    asRole('agent');

    // Unassigned tickets are triaged work and need `ticket:read_all`, so the
    // event log must not become a side channel onto one.
    await expect(events(UNHELD_TICKET)).rejects.toMatchObject({ code: 'not_found' });
  });
});
