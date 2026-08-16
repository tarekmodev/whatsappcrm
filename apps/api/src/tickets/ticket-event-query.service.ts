import { Inject, Injectable } from '@nestjs/common';
import type { CursorPage, TicketEvent, TicketEventListQuery } from '@whatsappcrm/contracts';
import {
  encodeTimestampCursor,
  readTimestampCursor,
  resumeAfter,
  type TimestampCursor,
} from '../common/pagination/timestamp-keyset';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  PUBLISHED_TICKET_EVENT_TYPES,
  TICKET_EVENT_PROJECTION,
  toTicketEventResponse,
} from './ticket-event.mapper';
import { TicketQueryService } from './ticket-query.service';
import { InvalidTicketCursorError } from './tickets.errors';

/**
 * `GET /api/v1/tickets/{id}/events` — the append-only history, and the read that
 * makes TAR-32's reassignment and escalation visible at all (ADR 0011 decision
 * 4). Reserved on `TicketsController` since TAR-25 and additive to it now.
 *
 * ## The ticket's visibility rule, borrowed rather than re-derived
 *
 * `TicketQueryService.require` runs first, so the log inherits the ticket's rule
 * exactly and cannot become a side channel onto a ticket the principal may not
 * open: a ticket in another tenant, or one a colleague holds, is `not_found`
 * here as it is on the detail read — never `forbidden`, which would confirm the
 * id names a real ticket.
 *
 * Nothing in this file re-states that rule, which is the point. A second copy
 * that drifts is a log endpoint that outlives a fix to the detail one.
 *
 * ## Keyset, on the index that already exists
 *
 * `created_at DESC, id DESC`, served by
 * `ticket_events (tenant_id, ticket_id, created_at DESC, id DESC)` — the
 * predicate and both sort keys in one index, so there is no Sort node and no new
 * index to add.
 *
 * Keyset rather than offset because a busy ticket accumulates events
 * indefinitely and an offset page over an append-only log is the one shape that
 * silently degrades: rows arriving between two page reads shift every subsequent
 * offset, so an event is shown twice or not at all. `take: limit + 1` answers
 * "is there another page" without a `count(*)`.
 *
 * No `type` filter at v1 (0011 decision 4): a ticket's history is short enough
 * to read whole, and one would cost an index on a column whose selectivity
 * nobody has measured.
 */
@Injectable()
export class TicketEventQueryService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tickets: TicketQueryService,
  ) {}

  async list(ticketId: string, query: TicketEventListQuery): Promise<CursorPage<TicketEvent>> {
    // Visibility first, and it is the only authorization this read makes: a
    // ticket the caller may not see has no log they may read.
    await this.tickets.require(ticketId);

    const cursor = readTimestampCursor(query.cursor);

    if (cursor.outcome === 'invalid') {
      throw new InvalidTicketCursorError('cursor');
    }

    const rows = await this.prisma.ticketEvent.findMany({
      where: {
        ticketId,
        ...PUBLISHED_TICKET_EVENT_TYPES,
        ...(cursor.outcome === 'cursor' ? resumeFrom(cursor.cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: TICKET_EVENT_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map(toTicketEventResponse),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTimestampCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }
}

/**
 * "Strictly after `(createdAt, id)` under `created_at DESC, id DESC`", in
 * `timestamp-keyset.ts`'s `bound`/`exclude` form — the shape the index can serve
 * as a start condition, with the already-shown part of the tie group subtracted.
 */
function resumeFrom(cursor: TimestampCursor): Prisma.TicketEventWhereInput {
  const { bound, exclude } = resumeAfter(cursor, 'desc');

  return { createdAt: bound, NOT: { createdAt: cursor.at, ...exclude } };
}
