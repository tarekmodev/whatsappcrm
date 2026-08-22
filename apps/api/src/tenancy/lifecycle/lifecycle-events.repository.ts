import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminTenantLifecycleEvent,
  CursorPage,
  TenantLifecycleEvent,
} from '@whatsappcrm/contracts';
import {
  encodeTimestampCursor,
  readTimestampCursor,
  resumeAfter,
} from '../../common/pagination/timestamp-keyset';
import type { Prisma } from '../../generated/prisma/client';
import { SYSTEM_PRISMA, type SystemPrisma } from '../../prisma/prisma.tokens';
import { InvalidLifecycleCursorError } from './tenant-lifecycle.errors';

/**
 * The columns the two projections are built from, and nothing else. `metadata`
 * is never read: it holds a provider event id and elapsed-timer measurements,
 * which are platform forensics rather than anything either caller renders.
 */
const EVENT_PROJECTION = {
  id: true,
  fromState: true,
  toState: true,
  trigger: true,
  actorType: true,
  actorLabel: true,
  reason: true,
  occurredAt: true,
} as const;

type EventRow = Prisma.LifecycleEventGetPayload<{ select: typeof EVENT_PROJECTION }>;

/**
 * **The only reader of `lifecycle_events`** (ADR 0009 decision 5, Amendment 1
 * ruling 2).
 *
 * ## Why this is one class with one query
 *
 * `lifecycle_events` is deliberately not tenant-scoped: it has no
 * `tenant_isolation` policy and no foreign key to `tenants`, because it has to
 * survive the purge and stay readable after the tenant it describes is no longer
 * serviceable. An audit trail you cannot read once the thing it describes has
 * been shut off is not an audit trail.
 *
 * The cost of that, stated in the ruling and paid here: **a tenant-facing read
 * of this table is an unscoped read.** Nothing in the database narrows it, so
 * the narrowing has to be exact, in one place, and reviewable. That is what this
 * class is. `tenantId` arrives as an argument from `principal.tenantId` — the
 * session, resolved by `PrincipalGuard` — and **never** from a request body,
 * query or path, and there is no method here that does not take one.
 *
 * ## Two projections, because `reason` is not the tenant's to read
 *
 * `reason` is operator free text: it is where somebody writes "fraud, card
 * chargeback". 0009's security section says that is not a sentence to show a
 * customer, so `forTenant` drops the column from the response and `forOperator`
 * keeps it. Two mapping functions rather than one with a flag, because a flag is
 * a parameter a handler can pass the wrong way round.
 *
 * ## Keyset, newest first
 *
 * `(tenant_id, occurred_at DESC, id DESC)` is the table's only index and it
 * exists for exactly this query. A tenant accumulates a handful of these over
 * its whole life, so paging is a formality — but the endpoint is published as a
 * `CursorPage`, and an unbounded list endpoint is not something to publish
 * whatever the expected row count.
 */
@Injectable()
export class LifecycleEventsRepository {
  constructor(@Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma) {}

  async forTenant(
    tenantId: string,
    query: { cursor?: string; limit: number },
  ): Promise<CursorPage<TenantLifecycleEvent>> {
    const { rows, nextCursor } = await this.page(tenantId, query);

    return { items: rows.map(toTenantEvent), nextCursor };
  }

  async forOperator(
    tenantId: string,
    query: { cursor?: string; limit: number },
  ): Promise<CursorPage<AdminTenantLifecycleEvent>> {
    const { rows, nextCursor } = await this.page(tenantId, query);

    return { items: rows.map(toOperatorEvent), nextCursor };
  }

  /**
   * One row more than asked for, so "is there another page" is answered by the
   * query rather than by a second count — and so a page that happens to be
   * exactly `limit` long does not hand back a cursor that resolves to nothing.
   */
  private async page(
    tenantId: string,
    query: { cursor?: string; limit: number },
  ): Promise<{ rows: EventRow[]; nextCursor: string | null }> {
    const cursor = readTimestampCursor(query.cursor);

    if (cursor.outcome === 'invalid') {
      throw new InvalidLifecycleCursorError();
    }

    const resume =
      cursor.outcome === 'cursor'
        ? (() => {
            const { bound, exclude } = resumeAfter(cursor.cursor, 'desc');

            return { occurredAt: bound, NOT: { occurredAt: cursor.cursor.at, ...exclude } };
          })()
        : {};

    const rows = await this.systemPrisma.lifecycleEvent.findMany({
      // The whole isolation guarantee for this table, in one clause. It is an
      // argument and never a request field; `lifecycle-events.int-spec.ts`
      // asserts a second tenant's rows are not returned.
      where: { tenantId, ...resume },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: EVENT_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      rows: page,
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTimestampCursor({ at: last.occurredAt, id: last.id })
          : null,
    };
  }
}

function toTenantEvent(row: EventRow): TenantLifecycleEvent {
  return {
    id: row.id,
    fromStatus: row.fromState,
    toStatus: row.toState,
    trigger: row.trigger,
    actorType: row.actorType,
    actorLabel: row.actorLabel,
    occurredAt: row.occurredAt.toISOString(),
  };
}

function toOperatorEvent(row: EventRow): AdminTenantLifecycleEvent {
  return { ...toTenantEvent(row), reason: row.reason };
}
