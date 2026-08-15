import { Inject, Injectable } from '@nestjs/common';
import {
  TICKET_ACTIVE_STATUSES,
  TICKET_PRIORITIES,
  TicketPrioritySchema,
  type CursorPage,
  type TicketListQuery,
  type TicketPriority,
  type TicketResponse,
} from '@whatsappcrm/contracts';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetCursor,
} from '../common/pagination/keyset-cursor';
import {
  encodeTimestampCursor,
  readTimestampCursor,
  resumeAfter,
  type TimestampCursor,
} from '../common/pagination/timestamp-keyset';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { assignedFilter, isVisible, narrowScope, unclaimedFilter } from '../rbac/visibility';
import { TICKET_PROJECTION, toTicketResponse, type TicketRow } from './ticket.mapper';
import {
  InvalidTicketCursorError,
  TicketNotFoundError,
  TicketRoutingInconsistentError,
} from './tickets.errors';

/**
 * How many sort columns a queue cursor carries, before the id tie-breaker:
 * `priority` then `createdAt`. A cursor minted by a list with a different sort
 * key decodes cleanly and is still wrong, so the arity is checked rather than
 * assumed — a mismatch is `validation_failed`, never a silent first page.
 */
const CURSOR_ARITY = 2;

/** The cursor row, once its two sort values have been validated. */
interface TicketCursor {
  readonly priority: TicketPriority;
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * One page's sort, and the three cursor operations that belong to it.
 *
 * Kept as one object per shape rather than as three parallel branches inside
 * `list`, because the failure mode of splitting them is silent: a cursor read by
 * one shape's arity check and resumed by the other's predicate pages from the
 * wrong place and reports nothing wrong. Here a shape's arity, its resume
 * clauses and its encoder cannot be mixed — they arrive together or not at all.
 */
interface TicketListOrder<TCursor> {
  readonly orderBy: readonly Prisma.TicketOrderByWithRelationInput[];
  /** The cursor as this shape can use it, `null` for a first page, or `'invalid'`. */
  readCursor(value: string | undefined): TCursor | null | 'invalid';
  /** "Strictly after the cursor row", as `where` fragments to conjoin. */
  resume(cursor: TCursor): Prisma.TicketWhereInput[];
  /** The cursor a caller pages on, minted from the last row of the page. */
  encode(row: TicketRow): string;
}

/** The queue's order: urgent first, newest first within a band (0006, §6). */
const QUEUE_ORDER: TicketListOrder<TicketCursor> = {
  orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  readCursor: readTicketCursor,
  resume: queueResumeClauses,
  encode: (row) =>
    encodeKeysetCursor({
      sortValues: [row.priority, row.createdAt.toISOString()],
      id: row.id,
    }),
};

/**
 * The flagged queue's order: **oldest stuck first**, which is what ADR 0008
 * decision 3 says `routing_deferred_since` exists for.
 *
 * `id` breaks the tie and is not optional. The ADR names one sort column, and one
 * column is not a total order: two tickets deferred in the same millisecond are
 * indistinguishable to a keyset predicate, and one of them is dropped at a page
 * boundary with no error anywhere. This is the arity-1 shape, so the id travels
 * in the cursor's own field rather than in its sort values.
 */
const DEFERRED_ORDER: TicketListOrder<TimestampCursor> = {
  orderBy: [{ routingDeferredSince: 'asc' }, { id: 'asc' }],
  readCursor: readDeferredCursor,
  resume: deferredResumeClauses,
  encode: (row) => encodeTimestampCursor({ at: deferredSinceOf(row), id: row.id }),
};

/**
 * The ticket reads: the queue, and one ticket's detail (0006, §6).
 *
 * ## Isolation
 *
 * Every statement runs on `TenantPrisma`, so `app.tenant_id` is set and TAR-48's
 * RLS supplies the tenant equality. There is no `tenantId` parameter in this
 * file, which is what makes "no cross-tenant read" a property of the wiring
 * rather than of remembering a filter. What this service adds is the
 * *intra*-tenant question RLS cannot answer: which of this tenant's tickets may
 * this principal see.
 *
 * That question is answered by `isVisible` — the **narrow** rule — and not by
 * the shared inbox's `isVisibleOrUnclaimed`. An unassigned ticket is triaged
 * work rather than a customer waiting in a pool, so browsing the tenant's
 * untriaged backlog needs `ticket:read_all`. `visibility.ts` states the
 * difference beside the two functions.
 *
 * ## The queue has one shape, and no parameter to change it
 *
 * `GET /tickets` with no `status` returns the **active** queue —
 * `status IN ('open','pending')` — ordered `priority DESC, createdAt DESC,
 * id DESC`. Both halves are decisions rather than defaults:
 *
 *   * The active-only default is what makes "resolve a ticket and it leaves the
 *     queue" true with no client change: the resolved ticket simply stops
 *     matching. A client that wants one asks for `status=resolved`. There is
 *     deliberately no way to ask for *every* status at once — that is a contract
 *     change filed for when a "closed tickets" view is asked for, not invented
 *     here.
 *   * There is no `sort` parameter. The queue has one order and `priority DESC`
 *     is the whole of "urgent first"; a parameter would be a second thing to
 *     index and a second cursor arity to validate. `createdAt DESC` within a
 *     priority band is newest-first, consistent with every other list in this
 *     product — FIFO-within-band is the arguably better helpdesk semantic and is
 *     a cursor-version bump away, but nothing asks for it yet.
 *
 * **`priority DESC` is urgent-first only because `ticket_priority` is declared
 * `low, normal, high, urgent`** and Postgres orders an enum by declaration
 * order. That is load-bearing and invisible; `ticket-queue.int-spec.ts` asserts
 * it against a real database so a reorder fails a test rather than a customer.
 *
 * ## The flagged queue is the one exception, and it is not a `sort` parameter
 *
 * A request pinned to the deferred set — `routingState=deferred`, or any
 * `deferredReason`, which the `tickets_routing_deferred_consistent` CHECK makes
 * equivalent — pages **oldest stuck first**: `routing_deferred_since ASC,
 * id ASC`. ADR 0008 decision 3 justifies that column's existence by exactly this
 * ordering ("what the supervisor list sorts by"), and 0008's amendment 3 records
 * why the implementation now matches it rather than the doc being corrected
 * towards the queue's order.
 *
 * Still not a `sort` parameter, and the distinction is the point: the shape
 * follows from *which set was asked for*, so there is no way for a caller to ask
 * for a third combination and no index to add for one. Two shapes, and a cursor
 * cannot cross between them — a queue cursor carries two sort values and a
 * deferred cursor carries one, so each shape's arity check refuses the other's
 * cursor with `validation_failed` instead of paging from the wrong place. The
 * flagged queue emits a **real** cursor for the same reason every other list
 * does: a supervisor with more stuck tickets than fit on a page must be able to
 * reach the rest, and a shape that always answered `nextCursor: null` would
 * silently drop them.
 *
 * Ordering by a nullable column is safe only because both entry conditions pin
 * the result to the deferred set, where the CHECK makes
 * `routing_deferred_since` non-null. `deferredSinceOf` refuses to mint a cursor
 * from a row that breaks that, rather than emitting `null` and losing the page.
 *
 * ## Query cost
 *
 * One statement per page and no relation load beyond the SLA timers: every other
 * published field is a column on `tickets`. `take: limit + 1` answers "is there
 * another page" without a `count(*)`. The queue page is served by
 * `tickets_active_queue_idx` — `(tenant_id, priority DESC, created_at DESC,
 * id DESC) WHERE status IN ('open','pending')`, added by 20260813120000 — which
 * covers the RLS equality, the default status filter and all three sort keys, so
 * there is no Sort node over the tenant's active set.
 * `ticket-queue-shape.int-spec.ts` asserts that property rather than a number.
 *
 * The flagged page is served by `tickets_routing_deferred_idx` —
 * `(tenant_id, routing_deferred_since) WHERE routing_state = 'deferred'` — which
 * supplies the predicate and the leading sort key. It does not carry `id`, so
 * the tie-breaker costs an incremental sort within each millisecond group, and
 * the default status filter is applied to the rows it reads. Both are accepted
 * deliberately: a tie group is one row in practice, and the deferred set is small
 * by definition — if it is not, the tenant has a staffing problem its supervisor
 * can already see. Adding `id` to that index is additive and is recorded in
 * 0008's amendment for when a tenant makes it worth measuring.
 *
 * A scoped queue (`scope=assigned`, the default) pays a bounded sort over the
 * principal's own backlog instead and needs no index of its own; a request with
 * an explicit non-active `status` falls back to
 * `(tenant_id, status, priority, created_at DESC)` plus a sort. Both are the
 * measured-if-it-matters case, stated rather than left to be discovered.
 */
@Injectable()
export class TicketQueryService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(query: TicketListQuery): Promise<CursorPage<TicketResponse>> {
    return isDeferredQuery(query)
      ? this.page(query, DEFERRED_ORDER)
      : this.page(query, QUEUE_ORDER);
  }

  /** One page in the given shape. The `where` is identical either way; only the order differs. */
  private async page<TCursor>(
    query: TicketListQuery,
    order: TicketListOrder<TCursor>,
  ): Promise<CursorPage<TicketResponse>> {
    const principal = this.tenantContext.requirePrincipal();
    const cursor = order.readCursor(query.cursor);

    if (cursor === 'invalid') {
      throw new InvalidTicketCursorError('cursor');
    }

    const rows = await this.prisma.ticket.findMany({
      where: {
        ...matchClauses(query),
        // Both the scope and the resume predicate are an `OR` on the same
        // object, so they go in `AND` — spreading them side by side would have
        // the second silently replace the first and page an unscoped queue.
        AND: [
          ...scopeClauses(query.scope, principal),
          ...(cursor === null ? [] : order.resume(cursor)),
        ],
      },
      orderBy: [...order.orderBy],
      // One more than asked for: its existence is the answer to "is there
      // another page", which is cheaper than counting a growing table.
      take: query.limit + 1,
      select: TICKET_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map(toTicketResponse),
      nextCursor: rows.length > query.limit && last !== undefined ? order.encode(last) : null,
    };
  }

  /** One ticket, as `GET /api/v1/tickets/{id}` publishes it. */
  async get(ticketId: string): Promise<TicketResponse> {
    return toTicketResponse(await this.require(ticketId));
  }

  /**
   * The row, or `TicketNotFoundError` — for an id that does not exist, one in
   * another tenant, and one this principal may not see. The three are
   * deliberately indistinguishable; see the error's own comment.
   *
   * Shared by every route that addresses a single ticket, **including the
   * write**, so the visibility check cannot be the thing one of them forgets.
   */
  async require(ticketId: string): Promise<TicketRow> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      select: TICKET_PROJECTION,
    });

    if (
      ticket === null ||
      !isVisible(ticket, this.tenantContext.requirePrincipal(), 'ticket:read_all')
    ) {
      throw new TicketNotFoundError(ticketId);
    }

    return ticket;
  }
}

/**
 * Whether this request is pinned to the deferred set, and so pages oldest-stuck
 * first rather than in the queue's order.
 *
 * `deferredReason` counts on its own, and that is a fact about the database
 * rather than a convenience: `tickets_routing_deferred_consistent` makes a
 * non-null reason equivalent to `routing_state = 'deferred'`, so a request
 * carrying one cannot match a row outside the deferred set — including the
 * contradictory `?routingState=manual&deferredReason=…`, which matches nothing
 * at all and has no order to get wrong.
 */
function isDeferredQuery(query: TicketListQuery): boolean {
  return query.routingState === 'deferred' || query.deferredReason !== undefined;
}

/** Every filter the list accepts, as one `where` fragment. The order is chosen separately. */
function matchClauses(query: TicketListQuery): Prisma.TicketWhereInput {
  return {
    // No `status` means the active queue, which is what makes "resolved
    // leaves the queue" true without the client asking for anything.
    ...(query.status === undefined
      ? { status: { in: TICKET_ACTIVE_STATUSES } }
      : { status: query.status }),
    ...(query.priority === undefined ? {} : { priority: query.priority }),
    // The requested assignee narrows the scope; it never widens it. Both are
    // plain keys on the same `where`, so Prisma conjoins them with the scope
    // clause in `AND`.
    ...(query.assignedUserId === undefined ? {} : { assignedUserId: query.assignedUserId }),
    ...(query.assignedTeamId === undefined ? {} : { assignedTeamId: query.assignedTeamId }),
    // Correct today and returns nothing until TAR-26 writes timers, which
    // needs no special-casing later. A `where` predicate, never a selection:
    // it decides which rows come back, not what is read off them.
    ...(query.breachedOnly ? { slaTimers: { some: { state: 'breached' } } } : {}),
    // TAR-274's supervisor landing query is `?scope=all&routingState=deferred`
    // (0008 decision 3) — the set of tickets rotation could place with nobody.
    // `tickets_routing_deferred_idx` is partial on this predicate and leads with
    // `routing_deferred_since`, which is the order `DEFERRED_ORDER` asks for.
    //
    // Unlike `breachedOnly` above, this one has a writer: `RuleEngineService`
    // sets the column in the branch that decided it (TAR-373), and
    // `POST /tickets/{id}/assign` clears it on a manual placement (TAR-374). So
    // the page carries real rows rather than being correct-but-empty.
    ...(query.routingState === undefined ? {} : { routingState: query.routingState }),
    // One reason out of the flagged set, for the supervisor's reason pills. An
    // equality on a column the partial index above has already narrowed to, so
    // it costs no index of its own.
    //
    // It narrows the **query** and not the page: filtering a fetched page
    // instead would report "no tickets for that reason" whenever the matching
    // ones sort past it — precisely the unstaffed night `none_available` and
    // `no_candidate_pool` exist to describe.
    ...(query.deferredReason === undefined ? {} : { routingDeferredReason: query.deferredReason }),
  };
}

/**
 * The scope the caller may actually have, as a `where` fragment — or nothing.
 *
 * `narrowScope` is the ticket rule and is imported rather than re-derived: a
 * caller without `ticket:read_all` asking for `all` or `unassigned` gets
 * `assigned`, narrowed rather than refused, so a supervisor's shared URL renders
 * for an agent with less in it instead of 403-ing.
 *
 * `assigned` is `assignedFilter` even for a principal holding `_all`: a
 * supervisor asking for their own work must get their own work, which is the
 * distinction `visibility.ts` draws between a visibility question and a chosen
 * filter.
 */
function scopeClauses(
  requested: TicketListQuery['scope'],
  principal: Parameters<typeof narrowScope>[1],
): Prisma.TicketWhereInput[] {
  const scope = narrowScope(requested, principal, 'ticket:read_all');

  if (scope === 'all') {
    // Only reachable with `ticket:read_all`; the whole tenant is in view and
    // there is nothing to narrow.
    return [];
  }

  return [scope === 'unassigned' ? unclaimedFilter() : assignedFilter(principal)];
}

/**
 * "Strictly after `(priority, createdAt, id)` under
 * `priority DESC, createdAt DESC, id DESC`", enumerated rather than bounded.
 *
 * Prisma's enum filters have no `lt`/`gt`, so the leading column's bound cannot
 * be written the way `timestamp-keyset.ts` writes a timestamp's — and that file
 * argues against exactly this plain-OR shape, because a planner cannot fold a
 * nested `OR` into one index start condition. The argument is about the inbox:
 * the hottest query in the product, over a table appended to continuously. A
 * tenant's *active ticket* set is orders of magnitude smaller, and the
 * `bound`/`exclude` trick cannot express a leading enum column at all.
 *
 * So the OR form is accepted here deliberately, and measured rather than
 * assumed. `ticket-queue-shape.int-spec.ts` explains a **cursor-resumed** page —
 * this predicate, not just the unfiltered first page — against 4 000 active
 * tickets in one tenant, as `whatsappcrm_app` under RLS. The planner folds the
 * `OR` into `tickets_active_queue_idx`:
 *
 * ```
 *   Limit / Index Scan using tickets_active_queue_idx
 * ```
 *
 * No Sort node, so the objection does not apply at this shape and size. The
 * spec asserts that property rather than a number; if a future planner answers
 * it with a sort over the tenant's active set instead, the answer is a raw-SQL
 * page for this one list.
 *
 * `prioritiesBelow('low')` is `[]`, which `in: []` matches nothing — correct for
 * the last band rather than a bug: there is no priority below `low`, so the only
 * rows left are that band's own.
 */
function queueResumeClauses(cursor: TicketCursor): Prisma.TicketWhereInput[] {
  return [
    {
      OR: [
        { priority: { in: prioritiesBelow(cursor.priority) } },
        { priority: cursor.priority, createdAt: { lt: cursor.createdAt } },
        { priority: cursor.priority, createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    },
  ];
}

/**
 * "Strictly after `(routingDeferredSince, id)` under
 * `routing_deferred_since ASC, id ASC`", in `timestamp-keyset.ts`'s
 * `bound`/`exclude` form.
 *
 * The inclusive bound on the leading column is what
 * `tickets_routing_deferred_idx` can serve as a start condition — the scan
 * begins at the cursor row and reads forward — and `exclude` subtracts the part
 * of that millisecond's tie group the caller has already been shown. The
 * shorter-looking `(since, id) > ($1, $2)` written as a conjunction is not
 * merely slower but wrong, and that file says why.
 */
function deferredResumeClauses(cursor: TimestampCursor): Prisma.TicketWhereInput[] {
  const resume = resumeAfter(cursor, 'asc');

  return [
    {
      routingDeferredSince: resume.bound,
      NOT: { routingDeferredSince: cursor.at, ...resume.exclude },
    },
  ];
}

/**
 * The bands that sort after this one under `priority DESC` — everything
 * declared before it in `TICKET_PRIORITIES`, which is `low, normal, high,
 * urgent`. Reordering that array inverts this function along with the queue.
 */
function prioritiesBelow(priority: TicketPriority): TicketPriority[] {
  return TICKET_PRIORITIES.slice(0, TICKET_PRIORITIES.indexOf(priority));
}

/**
 * The cursor as the queue can use it, `null` for a first page, or `'invalid'`.
 *
 * Three things have to hold and each is checked: it decodes, it carries exactly
 * this shape's two sort values, and both of them parse — a priority the enum
 * knows and a timestamp that is a real date. A cursor that decodes but carries
 * `['2026-08-13T…']` came from the flagged queue, and paging from it would
 * compare a timestamp against an enum column.
 *
 * `'invalid'` rather than a throw so the type says the caller must handle it,
 * and rather than falling back to the first page so a client that corrupted a
 * cursor is told instead of quietly re-reading page one forever.
 */
function readTicketCursor(value: string | undefined): TicketCursor | null | 'invalid' {
  if (value === undefined) {
    return null;
  }

  const decoded = decodeKeysetCursor(value);

  if (decoded === null || decoded.sortValues.length !== CURSOR_ARITY) {
    return 'invalid';
  }

  return toTicketCursor(decoded);
}

function toTicketCursor({ sortValues, id }: KeysetCursor): TicketCursor | 'invalid' {
  const [priority, createdAt] = sortValues;
  const parsedPriority = TicketPrioritySchema.safeParse(priority);
  const parsedCreatedAt = new Date(createdAt ?? '');

  return parsedPriority.success && !Number.isNaN(parsedCreatedAt.getTime())
    ? { priority: parsedPriority.data, createdAt: parsedCreatedAt, id }
    : 'invalid';
}

/**
 * The same three checks for the flagged queue's arity-1 cursor, delegated to
 * `readTimestampCursor` — which already refuses a cursor of another arity, so a
 * queue cursor replayed here is `validation_failed` rather than a comparison
 * between an enum label and a timestamp column.
 *
 * Translated into this file's `null | 'invalid'` shape rather than reusing the
 * `outcome` union, so both orders present one interface to `page`.
 */
function readDeferredCursor(value: string | undefined): TimestampCursor | null | 'invalid' {
  const result = readTimestampCursor(value);

  if (result.outcome === 'absent') {
    return null;
  }

  return result.outcome === 'invalid' ? 'invalid' : result.cursor;
}

/**
 * The row's `routing_deferred_since`, which on the flagged queue is never null.
 *
 * `tickets_routing_deferred_consistent` makes that an invariant of the database
 * rather than a hope, and every path into this shape is pinned to the deferred
 * set — so reaching the throw means the CHECK is gone or a writer worked around
 * it. It is a fault and is reported as one: `tickets.http.ts` does not translate
 * it, so it surfaces as a 500 with the ticket named in the log.
 *
 * The alternative — returning `nextCursor: null` for a row with no timestamp —
 * would answer "that is the whole queue" and lose every page after it, which is
 * the one outcome a supervisor cannot detect.
 */
function deferredSinceOf(row: TicketRow): Date {
  if (row.routingDeferredSince === null) {
    throw new TicketRoutingInconsistentError(row.id);
  }

  return row.routingDeferredSince;
}
