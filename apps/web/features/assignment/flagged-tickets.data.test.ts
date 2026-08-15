import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CursorPage,
  TeamResponse,
  TicketListQuery,
  TicketResponse,
  UserListQuery,
  UserResponse,
} from '@whatsappcrm/contracts';

/**
 * The loader is where the reason filter and the page cap meet, and getting that
 * wrong is invisible in every other test: a page of 25 looks exactly like a
 * complete queue unless something asserts what was *asked for*.
 *
 * `server-only` throws outside a React Server Component, so it is stubbed.
 */
vi.mock('server-only', () => ({}));

const listTickets = vi.fn<(query: TicketListQuery) => Promise<CursorPage<TicketResponse>>>();
const listUsers = vi.fn<(query: UserListQuery) => Promise<CursorPage<UserResponse>>>();
const listTeams = vi.fn<() => Promise<CursorPage<TeamResponse>>>();

vi.mock('@/lib/api/tickets', () => ({ listTickets: (q: TicketListQuery) => listTickets(q) }));
vi.mock('@/lib/api/users', () => ({ listUsers: (q: UserListQuery) => listUsers(q) }));
vi.mock('@/lib/api/teams', () => ({ listTeams: () => listTeams() }));

const { loadFlaggedTickets, RoutingFilterNotHonouredError } =
  await import('./flagged-tickets.data');
const { FLAGGED_TICKETS_PAGE_SIZE } = await import('./constants');

function ticket(id: string, reason: TicketResponse['routing']['deferredReason']): TicketResponse {
  return {
    id,
    number: 1,
    conversationId: null,
    contactId: null,
    subject: `Ticket ${id}`,
    status: 'open',
    priority: 'normal',
    assignedUserId: null,
    assignedTeamId: null,
    routing: { state: 'deferred', deferredReason: reason, deferredSince: '2026-08-10T07:00:00Z' },
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
    createdAt: '2026-08-10T07:00:00Z',
    updatedAt: '2026-08-10T07:00:00Z',
  };
}

function page<T>(items: T[], nextCursor: string | null = null): CursorPage<T> {
  return { items, nextCursor };
}

beforeEach(() => {
  listTickets.mockReset().mockResolvedValue(page([ticket('a', 'all_at_capacity')]));
  listUsers.mockReset().mockResolvedValue(page<UserResponse>([]));
  listTeams.mockReset().mockResolvedValue(page<TeamResponse>([]));
});

describe('loadFlaggedTickets', () => {
  it('asks for ADR 0008’s flagged query', async () => {
    await loadFlaggedTickets({});

    expect(listTickets).toHaveBeenCalledWith(
      expect.objectContaining({
        // `all` rather than `unassigned`: a deferred ticket that a rule routed to
        // a team still carries `assignedTeamId`, and `unassigned` means "no user
        // and no team" since TAR-286. `routingState` is what makes it the
        // flagged set.
        scope: 'all',
        routingState: 'deferred',
        limit: FLAGGED_TICKETS_PAGE_SIZE,
      }),
    );
  });

  /**
   * The regression the code reviewer found on PR #94: with the narrowing applied
   * after the fetch, a reason whose tickets sort past row 25 rendered "no tickets
   * for that reason" while they sat in the queue.
   */
  it('pushes the reason into the query rather than filtering the page', async () => {
    // The response has to match the request, or the guard below rejects it — which
    // is itself the point: asking for one reason and being handed another is not a
    // page to narrow, it is a filter that never ran.
    listTickets.mockResolvedValue(page([ticket('a', 'no_candidate_pool')]));

    await loadFlaggedTickets({ deferredReason: 'no_candidate_pool' });

    expect(listTickets).toHaveBeenCalledWith(
      expect.objectContaining({ deferredReason: 'no_candidate_pool' }),
    );
  });

  it('leaves the reason out of the query when no filter is applied', async () => {
    await loadFlaggedTickets({});

    expect(listTickets.mock.calls[0]?.[0].deferredReason).toBeUndefined();
  });

  it('returns the page the API answered with, in its order and entire', async () => {
    // Not narrowed a second time and not re-sorted: the API owns the filter and
    // the order, and the view claims neither of its own.
    //
    // A *mixed* page used to be the fixture for this, on the grounds that an
    // in-memory filter would drop the odd row out. It cannot be any more —
    // `assertRoutingFilterHonoured` rejects a page that disagrees with the
    // request, because such a page means the filter never ran. That case is now
    // its own test below.
    listTickets.mockResolvedValue(
      page([ticket('a', 'all_at_capacity'), ticket('b', 'all_at_capacity')]),
    );

    const report = await loadFlaggedTickets({ deferredReason: 'all_at_capacity' });

    expect(report.tickets.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('reports truncation when the API says there is another page', async () => {
    listTickets.mockResolvedValue(page([ticket('a', 'all_at_capacity')], 'cursor-1'));

    await expect(loadFlaggedTickets({})).resolves.toMatchObject({ hasMore: true });
  });

  it('reports a complete queue when there is no next cursor', async () => {
    await expect(loadFlaggedTickets({})).resolves.toMatchObject({ hasMore: false });
  });

  /**
   * The Major found on the rebased PR #94: `TicketListQuerySchema` accepted
   * `routingState` and `TicketQueryService.list` did not implement it, and an
   * unimplemented parameter is dropped rather than refused — so the response was a
   * valid page of the *active* queue, which rendered as "Showing 0" above
   * "Nothing is stuck".
   *
   * TAR-365 shipped both predicates, so this is no longer the live state of the
   * API. The guard stays: a filter that stops being honoured — a rollback, an
   * older API behind a newer console — is worth an error boundary rather than a
   * contradiction rendered calmly, and the check is one pass over a page.
   */
  it('refuses a page the routing filter was never applied to', async () => {
    listTickets.mockResolvedValue(
      page([
        {
          ...ticket('a', null),
          routing: { state: 'pending', deferredReason: null, deferredSince: null },
        },
      ]),
    );

    await expect(loadFlaggedTickets({})).rejects.toBeInstanceOf(RoutingFilterNotHonouredError);
  });

  it('names the offending ticket, so a log line says which filter was dropped', async () => {
    listTickets.mockResolvedValue(
      page([
        {
          ...ticket('a', null),
          routing: { state: 'assigned', deferredReason: null, deferredSince: null },
        },
      ]),
    );

    await expect(loadFlaggedTickets({})).rejects.toThrow(/routingState=deferred/);
  });

  it('refuses a page whose reason is not the one asked for', async () => {
    // The API honoured `routingState` and dropped `deferredReason`: every row is
    // deferred, none for the reason the pill selected.
    listTickets.mockResolvedValue(page([ticket('a', 'all_at_capacity')]));

    await expect(
      loadFlaggedTickets({ deferredReason: 'no_candidate_pool' }),
    ).rejects.toBeInstanceOf(RoutingFilterNotHonouredError);
  });

  it('accepts a page that matches the filter, which is what it costs now it does', async () => {
    listTickets.mockResolvedValue(
      page([ticket('a', 'none_available'), ticket('b', 'none_available')]),
    );

    await expect(loadFlaggedTickets({ deferredReason: 'none_available' })).resolves.toMatchObject({
      hasMore: false,
    });
  });

  it('accepts an empty page rather than reading it as a dropped filter', async () => {
    // Nothing deferred is the ordinary state of a healthy workspace, and an
    // empty page is not evidence that the filter was dropped.
    listTickets.mockResolvedValue(page([]));

    await expect(loadFlaggedTickets({})).resolves.toMatchObject({ tickets: [] });
  });

  it('asks only for accounts that can actually take a ticket', async () => {
    await loadFlaggedTickets({});

    // `invited` and `suspended` accounts are refused by the API's assign path, so
    // offering one would be a control that exists only to fail.
    expect(listUsers).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });
});
