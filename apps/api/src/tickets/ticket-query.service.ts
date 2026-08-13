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
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { assignedFilter, isVisible, narrowScope, unclaimedFilter } from '../rbac/visibility';
import { TICKET_PROJECTION, toTicketResponse, type TicketRow } from './ticket.mapper';
import { InvalidTicketCursorError, TicketNotFoundError } from './tickets.errors';

/**
 * How many sort columns a ticket cursor carries, before the id tie-breaker:
 * `priority` then `createdAt`. A cursor minted by a list with a different sort
 * key decodes cleanly and is still wrong, so the arity is checked rather than
 * assumed — a mismatch is `validation_failed`, never a silent first page.
 */
const CURSOR_ARITY = 2;

/** The queue's one order. There is no `sort` parameter; see the class comment. */
const QUEUE_ORDER: Prisma.TicketOrderByWithRelationInput[] = [
  { priority: 'desc' },
  { createdAt: 'desc' },
  { id: 'desc' },
];

/** The cursor row, once its two sort values have been validated. */
interface TicketCursor {
  readonly priority: TicketPriority;
  readonly createdAt: Date;
  readonly id: string;
}

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
 * ## Query cost
 *
 * One statement per page and no relation load: every published field is a column
 * on `tickets`. `take: limit + 1` answers "is there another page" without a
 * `count(*)`. The page is served by `tickets_active_queue_idx` —
 * `(tenant_id, priority DESC, created_at DESC, id DESC) WHERE status IN
 * ('open','pending')`, added by 20260813120000 — which covers the RLS equality,
 * the default status filter and all three sort keys, so there is no Sort node
 * over the tenant's active set. `ticket-queue-shape.int-spec.ts` asserts that
 * property rather than a number.
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
    const principal = this.tenantContext.requirePrincipal();
    const cursor = readTicketCursor(query.cursor);

    if (cursor === 'invalid') {
      throw new InvalidTicketCursorError('cursor');
    }

    const rows = await this.prisma.ticket.findMany({
      where: {
        // No `status` means the active queue, which is what makes "resolved
        // leaves the queue" true without the client asking for anything.
        ...(query.status === undefined
          ? { status: { in: TICKET_ACTIVE_STATUSES } }
          : { status: query.status }),
        ...(query.priority === undefined ? {} : { priority: query.priority }),
        // The requested assignee narrows the scope; it never widens it. Both are
        // plain keys on the same `where`, so Prisma conjoins them with the scope
        // clause in `AND` below.
        ...(query.assignedUserId === undefined ? {} : { assignedUserId: query.assignedUserId }),
        ...(query.assignedTeamId === undefined ? {} : { assignedTeamId: query.assignedTeamId }),
        // Correct today and returns nothing until TAR-26 writes timers, which
        // needs no special-casing later. A `where` predicate, never a selection:
        // it decides which rows come back, not what is read off them.
        ...(query.breachedOnly ? { slaTimers: { some: { state: 'breached' } } } : {}),
        // Both clauses are an `OR` on the same object, so they go in `AND` —
        // spreading them side by side would have the second silently replace the
        // first and page an unscoped queue.
        AND: [...scopeClauses(query.scope, principal), ...cursorClauses(cursor)],
      },
      orderBy: QUEUE_ORDER,
      // One more than asked for: its existence is the answer to "is there
      // another page", which is cheaper than counting a growing table.
      take: query.limit + 1,
      select: TICKET_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map(toTicketResponse),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeKeysetCursor({
              sortValues: [last.priority, last.createdAt.toISOString()],
              id: last.id,
            })
          : null,
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
 * So the OR form is accepted here deliberately, and asserted rather than
 * assumed: `ticket-queue-shape.int-spec.ts` measures the plan. If the numbers
 * ever disagree, the answer is a raw-SQL page for this one list.
 *
 * `prioritiesBelow('low')` is `[]`, which `in: []` matches nothing — correct for
 * the last band rather than a bug: there is no priority below `low`, so the only
 * rows left are that band's own.
 */
function cursorClauses(cursor: TicketCursor | null): Prisma.TicketWhereInput[] {
  if (cursor === null) {
    return [];
  }

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
 * The bands that sort after this one under `priority DESC` — everything
 * declared before it in `TICKET_PRIORITIES`, which is `low, normal, high,
 * urgent`. Reordering that array inverts this function along with the queue.
 */
function prioritiesBelow(priority: TicketPriority): TicketPriority[] {
  return TICKET_PRIORITIES.slice(0, TICKET_PRIORITIES.indexOf(priority));
}

/**
 * The cursor as this list can use it, `null` for a first page, or `'invalid'`.
 *
 * Three things have to hold and each is checked: it decodes, it carries exactly
 * this list's two sort values, and both of them parse — a priority the enum
 * knows and a timestamp that is a real date. A cursor that decodes but carries
 * `['2026-08-13T…']` came from another list, and paging from it would compare a
 * timestamp against an enum column.
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
