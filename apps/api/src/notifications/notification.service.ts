import { Inject, Injectable } from '@nestjs/common';
import type {
  CursorPage,
  NotificationListQuery,
  NotificationResponse,
} from '@whatsappcrm/contracts';
import {
  encodeTimestampCursor,
  readTimestampCursor,
  resumeAfter,
  type TimestampCursor,
} from '../common/pagination/timestamp-keyset';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  NOTIFICATION_PROJECTION,
  PUBLISHED_NOTIFICATION_TYPES_ONLY,
  toNotificationResponse,
} from './notification.mapper';
import { InvalidNotificationCursorError, NotificationNotFoundError } from './notifications.errors';

/**
 * The generalised inbox 0009 decision 7 published: one list and one acknowledge
 * over every notification type, where `GET /api/v1/sla-alerts` and
 * `GET /api/v1/escalation-alerts` are single-type views of the same table.
 *
 * Read-only. Nothing here writes a notification — `SlaSweepService`,
 * `WorkflowActionExecutor` and `WorkflowTriggerService` do, each with its own
 * idempotency key — which is what keeps this module below all three and
 * importing none of them.
 *
 * ## Every read is narrowed to the calling principal, on top of RLS
 *
 * `GET /api/v1/notifications` needs no `_all` permission and does not have one.
 * Every row names its recipient, and the query adds
 * `recipient_user_id = principal.userId` — two layers, and the outer one is what
 * stops one supervisor reading another's inbox. An agent may call the endpoint;
 * they get whatever was addressed to them, which for a `workflow_broken` row is
 * nothing, because only admins receive those.
 *
 * The same narrowing is what makes acknowledging another principal's
 * notification a `not_found` rather than a `forbidden`.
 */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The caller's notifications, newest first, keyset paginated on
   * `(created_at DESC, id DESC)` — served by
   * `notifications (tenant_id, recipient_user_id, created_at DESC, id DESC)`,
   * which carries the recipient filter and the sort in one index.
   *
   * `type` is a filter on top of that index rather than a column in it, which is
   * the trade TAR-394 recorded when it declined to index the column: the set is
   * already bounded by one recipient and one page, and putting `type` in the
   * middle of the index would cost **this** list its sort order. The optional
   * `type` query parameter therefore narrows a page that has already been
   * bounded, and is not a scan.
   */
  async list(query: NotificationListQuery): Promise<CursorPage<NotificationResponse>> {
    const recipientUserId = this.tenantContext.requirePrincipal().userId;
    const cursor = readTimestampCursor(query.cursor);

    if (cursor.outcome === 'invalid') {
      throw new InvalidNotificationCursorError('cursor');
    }

    const rows = await this.prisma.notification.findMany({
      where: {
        ...mine(recipientUserId, query.type),
        ...(query.unacknowledgedOnly ? { acknowledgedAt: null } : {}),
        ...(cursor.outcome === 'cursor' ? resumeFrom(cursor.cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One more than the page, so "is there another page" costs a row rather
      // than a `count(*)` over the whole filtered set on every request.
      take: query.limit + 1,
      select: NOTIFICATION_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map(toNotificationResponse),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTimestampCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * Marks a notification read. **Idempotent**: a second call returns the same
   * row with the original `acknowledged_at`, and nothing is a 409.
   *
   * First write wins, in the `WHERE` clause rather than by reading first — the
   * timestamp answers "when did you see this", and two tabs clicking at once
   * must not move it. Zero rows updated therefore means either "already
   * acknowledged" or "not yours", and the read that follows tells those apart:
   * it is narrowed to the principal, so somebody else's notification answers
   * `not_found`.
   *
   * **This and `POST /api/v1/sla-alerts/{id}/acknowledge` write the same column
   * on the same row.** Acknowledging a breach through either endpoint is the
   * same act, which is the point of one table and one unread count — and the
   * first-write-wins predicate is what makes the two safe to race.
   */
  async acknowledge(notificationId: string): Promise<NotificationResponse> {
    const recipientUserId = this.tenantContext.requirePrincipal().userId;

    await this.prisma.notification.updateMany({
      where: { ...mine(recipientUserId), id: notificationId, acknowledgedAt: null },
      data: { acknowledgedAt: new Date() },
    });

    const notification = await this.prisma.notification.findFirst({
      where: { ...mine(recipientUserId), id: notificationId },
      select: NOTIFICATION_PROJECTION,
    });

    if (notification === null) {
      throw new NotificationNotFoundError(notificationId);
    }

    return toNotificationResponse(notification);
  }
}

/**
 * The predicate every statement in the service spreads: the published types,
 * addressed to the caller.
 *
 * One fragment rather than two spreads per query, because forgetting either half
 * is a different bug and both are silent — the recipient half is a cross-principal
 * read, and the type half answers with a `type` the published enum does not
 * contain.
 *
 * A named `type` needs no `in` beside it: `NotificationListQuerySchema` parses it
 * as `NotificationTypeSchema`, so the only values that reach here are already the
 * published ones.
 */
function mine(
  recipientUserId: string,
  type?: NotificationListQuery['type'],
): Prisma.NotificationWhereInput {
  return {
    ...(type === undefined ? PUBLISHED_NOTIFICATION_TYPES_ONLY : { type }),
    recipientUserId,
  };
}

/** The resume predicate 0002 rules, on `created_at` descending. */
function resumeFrom(cursor: TimestampCursor): Prisma.NotificationWhereInput {
  const { bound, exclude } = resumeAfter(cursor, 'desc');

  return { createdAt: bound, NOT: { createdAt: cursor.at, ...exclude } };
}
