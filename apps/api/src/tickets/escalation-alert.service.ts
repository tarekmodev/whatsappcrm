import { Inject, Injectable } from '@nestjs/common';
import {
  TENANT_ROLES,
  roleHasPermission,
  type CursorPage,
  type EscalationAlertListQuery,
  type EscalationAlertResponse,
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
import {
  resolveAlertRecipients,
  type AlertCandidate,
  type TicketResponsibility,
} from '../sla/sla-recipients';
import {
  ESCALATION_ALERT_PROJECTION,
  ESCALATION_ONLY,
  toEscalationAlertResponse,
} from './escalation-alert.mapper';
import {
  EscalationAlertNotFoundError,
  InvalidTicketCursorError,
  UnknownEscalationRecipientError,
} from './tickets.errors';

/**
 * The supervisor's side of an escalation: who is told, and what they read
 * (TAR-32, ADR 0011 decision 5, as amended by TAR-468).
 *
 * ## The recipient rule is imported, not rewritten
 *
 * `resolveAlertRecipients` is ADR 0006 decision 4's rule and already ships in
 * `sla/sla-recipients.ts`. 0011 says in as many words that this module imports
 * it unchanged: an escalation and a breach ask the same question — which of this
 * tenant's supervisors is responsible for this ticket — and two answers that
 * drift would mean a tenant whose breaches reach one group and whose escalations
 * reach another.
 *
 * That import crosses a layer: `sla` is L4 and this is L3. It is the category of
 * sharing `SlaBreachResourceService` and `MessageResourceService` document at
 * length — a **pure function over rows the caller has already read**, with no
 * provider, no injection and no module edge. Nothing here imports `SlaModule`.
 *
 * ## Every read is narrowed to the calling principal, on top of RLS
 *
 * `GET /api/v1/escalation-alerts` needs no `_all` permission and does not have
 * one. Every row names its recipient and the query adds
 * `recipient_user_id = principal.userId` — two layers, and the outer one is what
 * stops one supervisor reading another's queue. An agent may call the endpoint
 * and gets an empty page, which is the whole of the role-scoping requirement,
 * enforced server-side rather than by hiding a button.
 *
 * The same narrowing is what makes acknowledging another principal's alert a
 * `not_found` rather than a `forbidden`.
 */

/**
 * The roles an escalation may be delivered to: exactly those holding
 * `ticket:read_all`.
 *
 * Derived from the matrix rather than restated as `[supervisor, admin]`, because
 * the population is not "supervisors and admins" — it is "principals who can
 * already read the ticket", which is what makes telling them about it disclose
 * nothing new (ADR 0006 decision 4). A fourth role granted `ticket:read_all`
 * should start receiving escalations without an edit here, and one that loses it
 * should stop.
 */
const ESCALATION_RECIPIENT_ROLES: readonly UserRole[] = TENANT_ROLES.filter((role) =>
  roleHasPermission(role, 'ticket:read_all'),
);

/** One `notifications` row this escalation actually wrote. */
export interface InsertedEscalationAlert {
  readonly id: string;
  readonly recipientUserId: string;
}

export interface EscalationAlertInsert {
  readonly tenantId: string;
  readonly ticketId: string;
  /** The `escalated` event these alerts belong to — group key and idempotency key at once. */
  readonly ticketEventId: string;
  readonly recipientUserIds: readonly string[];
}

/** The two assignment columns the recipient rule reads. */
export interface EscalatedTicket {
  readonly assignedUserId: string | null;
  readonly assignedTeamId: string | null;
}

@Injectable()
export class EscalationAlertService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Who this escalation is delivered to (ADR 0011 decision 3).
   *
   * Two paths, and the branch is the caller's `toUserId`:
   *
   *   * **named** — the user must exist in this tenant, be active, and hold
   *     `ticket:read_all`. Anything else is `validation_failed` on the field,
   *     mirroring `UnknownTicketAssigneeError`, and exactly one alert is
   *     written;
   *   * **derived** — active supervisors and admins, narrowed to those sharing a
   *     team with whoever holds the ticket, falling back to every candidate when
   *     that yields nobody.
   *
   * **Outside the escalation's transaction, and knowingly** (0011 decision 5,
   * step 2): a supervisor suspended in the milliseconds between this read and
   * the write is told about one ticket they can no longer act on. A lock
   * spanning the two is a heavier cure than the disease — the same trade
   * `assertAssigneesExist` already makes one method over.
   *
   * An empty result is a legitimate outcome, not an error: a tenant with no
   * active supervisor or admin at all. The escalation is still recorded, and the
   * console says "recorded, but nobody was notified".
   *
   * Two indexed reads at most: the candidates, served by `users (tenant_id,
   * status)` with a bounded nested load, and the holder's teams, served by
   * `team_members (tenant_id, user_id, team_id)`. Both go through `TenantPrisma`,
   * so an id naming another tenant's user is simply not there.
   */
  async resolveRecipients(
    ticket: EscalatedTicket,
    toUserId: string | undefined,
  ): Promise<string[]> {
    if (toUserId !== undefined) {
      return [await this.requireNamedRecipient(toUserId)];
    }

    const candidates = await this.loadCandidates();

    if (candidates.length === 0) {
      return [];
    }

    const responsibility: TicketResponsibility = {
      assignedUserId: ticket.assignedUserId,
      assignedTeamId: ticket.assignedTeamId,
      assignedUserTeamIds: await this.teamsOf(ticket.assignedUserId),
    };

    return resolveAlertRecipients(candidates, responsibility);
  }

  /**
   * The alert rows this escalation inserted, and only those.
   *
   * Takes the caller's transaction client so the rows land with the `escalated`
   * event or not at all (0011 decision 5, step 3): an alert without an audit
   * entry is a notification nobody can explain, and an audit entry without
   * alerts claims a supervisor was told when none was.
   *
   * `skipDuplicates` is the `ON CONFLICT (tenant_id, ticket_event_id,
   * recipient_user_id) DO NOTHING` TAR-468's unique exists for. It cannot fire
   * on a first attempt — the event row is created in this same transaction and
   * is unique by construction — so it covers only a retry of a partially
   * committed write.
   *
   * Returning only what was written is what bounds the realtime emit: one socket
   * per row inserted, never one per recipient considered.
   */
  async insertForEscalation(
    tx: Prisma.TransactionClient,
    escalation: EscalationAlertInsert,
  ): Promise<InsertedEscalationAlert[]> {
    if (escalation.recipientUserIds.length === 0) {
      return [];
    }

    return await tx.notification.createManyAndReturn({
      data: escalation.recipientUserIds.map((recipientUserId) => ({
        tenantId: escalation.tenantId,
        // Explicit rather than left to the column default, which exists so that
        // a writer forgetting the column fails the CHECK loudly (0009 decision
        // 7). Relying on it here would make this the writer that forgot — and
        // the default is `sla_breach`, whose own CHECK this row would then fail.
        type: 'escalation' as const,
        ticketId: escalation.ticketId,
        ticketEventId: escalation.ticketEventId,
        recipientUserId,
      })),
      skipDuplicates: true,
      select: { id: true, recipientUserId: true },
    });
  }

  /**
   * The caller's escalations, newest first, keyset paginated on
   * `(created_at DESC, id DESC)` — served by `notifications (tenant_id,
   * recipient_user_id, created_at DESC, id DESC)`, which carries the recipient
   * filter and the sort in one index.
   *
   * `type = 'escalation'` is a filter on top of that index rather than a column
   * in it, for the reason TAR-394 recorded: putting `type` in the middle would
   * cost the wider notification list its sort order, and the set is already
   * bounded by one recipient and one page.
   */
  async list(query: EscalationAlertListQuery): Promise<CursorPage<EscalationAlertResponse>> {
    const principal = this.tenantContext.requirePrincipal();
    const cursor = readTimestampCursor(query.cursor);

    if (cursor.outcome === 'invalid') {
      throw new InvalidTicketCursorError('cursor');
    }

    const rows = await this.prisma.notification.findMany({
      where: {
        ...ESCALATION_ONLY,
        recipientUserId: principal.userId,
        ...(query.unacknowledgedOnly ? { acknowledgedAt: null } : {}),
        ...(cursor.outcome === 'cursor' ? resumeFrom(cursor.cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: ESCALATION_ALERT_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map(toEscalationAlertResponse),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTimestampCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * Marks an escalation read. **Idempotent**: a second call returns the same row
   * with the original `acknowledged_at`, and nothing is a 409.
   *
   * First write wins, in the `WHERE` clause rather than by reading first — the
   * timestamp answers "when did you see this", and two tabs clicking at once
   * must not move it. Zero rows updated therefore means either "already
   * acknowledged" or "not yours", and the read that follows tells those apart:
   * it is narrowed to the principal, so somebody else's alert answers
   * `not_found`.
   */
  async acknowledge(alertId: string): Promise<EscalationAlertResponse> {
    const principal = this.tenantContext.requirePrincipal();

    await this.prisma.notification.updateMany({
      where: {
        ...ESCALATION_ONLY,
        id: alertId,
        recipientUserId: principal.userId,
        acknowledgedAt: null,
      },
      data: { acknowledgedAt: new Date() },
    });

    const alert = await this.prisma.notification.findFirst({
      where: { ...ESCALATION_ONLY, id: alertId, recipientUserId: principal.userId },
      select: ESCALATION_ALERT_PROJECTION,
    });

    if (alert === null) {
      throw new EscalationAlertNotFoundError(alertId);
    }

    return toEscalationAlertResponse(alert);
  }

  /**
   * The named supervisor, or `validation_failed` on the field.
   *
   * One tenant-scoped read carrying all three conditions, so an id in another
   * tenant, a suspended account and an agent are indistinguishable in the
   * answer — which is what stops the message being used to learn that a UUID
   * names somebody real elsewhere.
   */
  private async requireNamedRecipient(toUserId: string): Promise<string> {
    const recipient = await this.prisma.user.findUnique({
      where: {
        id: toUserId,
        status: UserStatus.active,
        role: { in: [...ESCALATION_RECIPIENT_ROLES] },
      },
      select: { id: true },
    });

    if (recipient === null) {
      throw new UnknownEscalationRecipientError(toUserId);
    }

    return recipient.id;
  }

  /** This tenant's escalation candidates, with the teams each belongs to. */
  private async loadCandidates(): Promise<AlertCandidate[]> {
    const candidates = await this.prisma.user.findMany({
      where: { role: { in: [...ESCALATION_RECIPIENT_ROLES] }, status: UserStatus.active },
      select: { id: true, teamMemberships: { select: { teamId: true } } },
    });

    return candidates.map((candidate) => ({
      id: candidate.id,
      teamIds: candidate.teamMemberships.map((membership) => membership.teamId),
    }));
  }

  private async teamsOf(userId: string | null): Promise<readonly string[]> {
    if (userId === null) {
      return [];
    }

    const memberships = await this.prisma.teamMember.findMany({
      where: { userId },
      select: { teamId: true },
    });

    return memberships.map((membership) => membership.teamId);
  }
}

/** The resume predicate 0002 rules, on `created_at` descending. */
function resumeFrom(cursor: TimestampCursor): Prisma.NotificationWhereInput {
  const { bound, exclude } = resumeAfter(cursor, 'desc');

  return { createdAt: bound, NOT: { createdAt: cursor.at, ...exclude } };
}
