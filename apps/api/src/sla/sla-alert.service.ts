import { Inject, Injectable } from '@nestjs/common';
import type {
  CursorPage,
  SlaAlertListQuery,
  SlaAlertResponse,
  SlaTargetKind,
} from '@whatsappcrm/contracts';
import {
  encodeTimestampCursor,
  readTimestampCursor,
  resumeAfter,
  type TimestampCursor,
} from '../common/pagination/timestamp-keyset';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { UserRole, UserStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { SLA_ALERT_PROJECTION, toSlaAlertResponse } from './sla-alert.mapper';
import {
  resolveAlertRecipients,
  type AlertCandidate,
  type TicketResponsibility,
} from './sla-recipients';
import { InvalidSlaCursorError, SlaAlertNotFoundError } from './sla.errors';

/**
 * The supervisor's side of an SLA breach: who is told, and what they read.
 *
 * ## Every read is narrowed to the calling principal, on top of RLS
 *
 * `GET /api/v1/sla-alerts` needs no `_all` permission and does not have one.
 * Every row names its recipient, and the query adds `recipient_user_id =
 * principal.userId` — two layers, and the outer one is what stops one supervisor
 * reading another's queue. An agent may call the endpoint and gets an empty
 * page, which is the whole of the role-scoping requirement, enforced
 * server-side rather than by hiding a button.
 *
 * The same narrowing is what makes acknowledging another principal's alert a
 * `not_found` rather than a `forbidden`: a 403 would confirm the id names a real
 * alert somebody else was sent.
 */

/**
 * The roles that receive an alert — the same population as "holds
 * `ticket:read_all`" in 0004's matrix, so an alert exposes nothing its recipient
 * could not already read.
 */
const ALERT_ROLES: readonly UserRole[] = [UserRole.supervisor, UserRole.admin];

/** One `sla_alerts` row this breach actually wrote. */
export interface InsertedSlaAlert {
  readonly id: string;
  readonly recipientUserId: string;
}

export interface BreachedTimerAlert {
  readonly tenantId: string;
  readonly slaTimerId: string;
  readonly ticketId: string;
  readonly kind: SlaTargetKind;
  readonly dueAt: Date;
  readonly recipientUserIds: readonly string[];
}

@Injectable()
export class SlaAlertService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The tenant's alert candidates: its active supervisors and admins, with the
   * teams each belongs to.
   *
   * **Read once per sweep transaction, not once per breach.** The answer is
   * invariant for the whole transaction — only the assigned user's teams vary by
   * ticket — and the recovery path this class is sized for is a full 200-timer
   * batch inside one transaction, so folding it into `resolveRecipients` meant
   * 200 identical queries against `users` and `team_members`. One read, served by
   * `users (tenant_id, status)` with a bounded nested load.
   */
  async loadAlertCandidates(tx: Prisma.TransactionClient): Promise<AlertCandidate[]> {
    const candidates = await tx.user.findMany({
      where: { role: { in: [...ALERT_ROLES] }, status: UserStatus.active },
      select: { id: true, teamMemberships: { select: { teamId: true } } },
    });

    return candidates.map((candidate) => ({
      id: candidate.id,
      teamIds: candidate.teamMemberships.map((membership) => membership.teamId),
    }));
  }

  /**
   * Who to tell about a breach on this ticket (0006, decision 4). Runs inside
   * the sweep's per-tenant transaction, so every read is scoped by the same RLS
   * the writes that follow it are.
   *
   * One indexed read per breach, and only when a person holds the ticket: that
   * person's teams, served by `team_members (tenant_id, user_id, team_id)`. The
   * candidate list is the caller's, hoisted out of the loop. The rule itself is
   * a pure function so it can be tested without a database.
   */
  async resolveRecipients(
    tx: Prisma.TransactionClient,
    candidates: readonly AlertCandidate[],
    ticket: { assignedUserId: string | null; assignedTeamId: string | null },
  ): Promise<string[]> {
    if (candidates.length === 0) {
      return [];
    }

    const responsibility: TicketResponsibility = {
      assignedUserId: ticket.assignedUserId,
      assignedTeamId: ticket.assignedTeamId,
      assignedUserTeamIds: await this.teamsOf(tx, ticket.assignedUserId),
    };

    return resolveAlertRecipients(candidates, responsibility);
  }

  /**
   * The alert rows this breach inserted, and only those.
   *
   * `skipDuplicates` is the `ON CONFLICT (tenant_id, sla_timer_id,
   * recipient_user_id) DO NOTHING` of 0006's third statement — the second
   * idempotency layer, which makes a retry after a partial failure re-insert
   * nothing. The load-bearing layer is the conditional flip that claimed the
   * timer in the same transaction; this one covers the window between that flip
   * and these inserts.
   *
   * Returning only what was written is what bounds the realtime emit: one socket
   * per row inserted, never one per recipient considered.
   */
  async insertForBreach(
    tx: Prisma.TransactionClient,
    breach: BreachedTimerAlert,
  ): Promise<InsertedSlaAlert[]> {
    if (breach.recipientUserIds.length === 0) {
      return [];
    }

    return await tx.slaAlert.createManyAndReturn({
      data: breach.recipientUserIds.map((recipientUserId) => ({
        tenantId: breach.tenantId,
        slaTimerId: breach.slaTimerId,
        ticketId: breach.ticketId,
        recipientUserId,
        kind: breach.kind,
        dueAt: breach.dueAt,
      })),
      skipDuplicates: true,
      select: { id: true, recipientUserId: true },
    });
  }

  /**
   * The caller's alerts, newest first, keyset paginated on
   * `(created_at DESC, id DESC)` — served by
   * `sla_alerts (tenant_id, recipient_user_id, created_at DESC, id DESC)`, which
   * carries the recipient filter and the sort in one index.
   */
  async list(query: SlaAlertListQuery): Promise<CursorPage<SlaAlertResponse>> {
    const principal = this.tenantContext.requirePrincipal();
    const cursor = readTimestampCursor(query.cursor);

    if (cursor.outcome === 'invalid') {
      throw new InvalidSlaCursorError('cursor');
    }

    const rows = await this.prisma.slaAlert.findMany({
      where: {
        recipientUserId: principal.userId,
        ...(query.unacknowledgedOnly ? { acknowledgedAt: null } : {}),
        ...(cursor.outcome === 'cursor' ? resumeFrom(cursor.cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: SLA_ALERT_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map(toSlaAlertResponse),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTimestampCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * Marks an alert read. **Idempotent**: a second call returns the same row with
   * the original `acknowledged_at`, and nothing is a 409.
   *
   * First write wins, in the `WHERE` clause rather than by reading first — the
   * timestamp answers "when did you see this", and two tabs clicking at once
   * must not move it. Zero rows updated therefore means either "already
   * acknowledged" or "not yours", and the read that follows tells those apart:
   * it is narrowed to the principal, so somebody else's alert answers
   * `not_found`.
   */
  async acknowledge(alertId: string): Promise<SlaAlertResponse> {
    const principal = this.tenantContext.requirePrincipal();

    await this.prisma.slaAlert.updateMany({
      where: { id: alertId, recipientUserId: principal.userId, acknowledgedAt: null },
      data: { acknowledgedAt: new Date() },
    });

    const alert = await this.prisma.slaAlert.findFirst({
      where: { id: alertId, recipientUserId: principal.userId },
      select: SLA_ALERT_PROJECTION,
    });

    if (alert === null) {
      throw new SlaAlertNotFoundError(alertId);
    }

    return toSlaAlertResponse(alert);
  }

  private async teamsOf(
    tx: Prisma.TransactionClient,
    userId: string | null,
  ): Promise<readonly string[]> {
    if (userId === null) {
      return [];
    }

    const memberships = await tx.teamMember.findMany({
      where: { userId },
      select: { teamId: true },
    });

    return memberships.map((membership) => membership.teamId);
  }
}

/** The resume predicate 0002 rules, on `created_at` descending. */
function resumeFrom(cursor: TimestampCursor): Prisma.SlaAlertWhereInput {
  const { bound, exclude } = resumeAfter(cursor, 'desc');

  return { createdAt: bound, NOT: { createdAt: cursor.at, ...exclude } };
}
