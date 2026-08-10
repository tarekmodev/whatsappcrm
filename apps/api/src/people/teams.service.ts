import { Inject, Injectable } from '@nestjs/common';
import type {
  CursorPage,
  TeamCreateInput,
  TeamListQuery,
  TeamResponse,
  TeamUpdateInput,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { SessionRevocationService } from '../rbac/session-revocation.service';
import { toTeamResponse, type TeamRow } from './people.mapper';
import { TeamNameTakenError, TeamNotFoundError, UnknownReferenceError } from './people.errors';

const TEAM_PROJECTION = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  members: { select: { userId: true } },
} as const satisfies Prisma.TeamSelect;

/**
 * Teams (TAR-22 AC2). A team is a routing target and a visibility boundary: a
 * conversation assigned to one is visible to every member and to nobody else
 * without `conversation:read_all`.
 *
 * That second property is why membership changes are not an ordinary update.
 * Adding somebody to Billing widens what they can read, removing them narrows
 * it, and `SessionPrincipal.teamIds` is a snapshot taken when the session was
 * resolved — so both directions revoke the affected users' sessions in the same
 * transaction. Without that, a removed member keeps reading the team's
 * conversations until their session happens to expire.
 *
 * `team:read` is granted to every role because an agent has to see the team
 * names on their own conversations; `team:write` is supervisor and admin.
 */
@Injectable()
export class TeamsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly sessions: SessionRevocationService,
  ) {}

  async list(query: TeamListQuery): Promise<CursorPage<TeamResponse>> {
    const rows = await this.prisma.team.findMany({
      where: {
        // `name` is `citext`, so this is already case-insensitive at the column.
        ...(query.q === undefined ? {} : { name: { contains: query.q } }),
        ...(query.cursor === undefined ? {} : { id: { gt: query.cursor } }),
      },
      select: TEAM_PROJECTION,
      // Ascending by id, unlike the people list: teams are a small, stable set
      // that a picker renders whole, and newest-first would reshuffle the
      // dropdown every time somebody adds one.
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });

    return toPage(rows, query.limit);
  }

  async create(input: TeamCreateInput): Promise<TeamResponse> {
    const tenantId = this.tenantContext.requireTenantId();

    return this.prisma.$tenantTransaction(async (tx) => {
      await assertUsersExist(tx, tenantId, input.memberUserIds);

      const created = await tx.team
        .create({
          data: { tenantId, name: input.name, description: input.description ?? null },
          select: { id: true },
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? new TeamNameTakenError(input.name) : error;
        });

      // Members are written separately rather than as a nested `create`:
      // `team_members` reaches its parents through composite keys
      // `(tenant_id, team_id)` and `(tenant_id, user_id)`, so `tenant_id` is a
      // relation scalar Prisma will not accept inside a nested write — and it
      // is not optional, because it is half of what makes the tenant boundary
      // hold.
      if (input.memberUserIds.length > 0) {
        await tx.teamMember.createMany({
          data: input.memberUserIds.map((userId) => ({ tenantId, teamId: created.id, userId })),
        });
      }

      const team = await tx.team.findUniqueOrThrow({
        where: { id: created.id },
        select: TEAM_PROJECTION,
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.teamCreated,
        targetType: 'team',
        targetId: team.id,
        metadata: { name: team.name, memberUserIds: input.memberUserIds },
      });

      // Everyone placed in the team at creation gains visibility of whatever is
      // routed to it, so their cached `teamIds` is already wrong.
      await this.revokeFor(tx, tenantId, input.memberUserIds);

      return toTeamResponse(team);
    });
  }

  /**
   * `memberUserIds` replaces the membership; omitting it leaves it alone.
   *
   * This route is not in TAR-39's published endpoint table — it exports
   * `TeamUpdateInputSchema` and then lists only `GET` and `POST /teams`. Added
   * here because TAR-22 AC3 asks a supervisor to manage teams, and without it
   * they could create a team and never change who is in it: the other way to
   * move somebody between teams is `PATCH /users/{id}`, which needs
   * `user:update`. Raised by TAR-82, and additive — no existing client breaks.
   */
  async update(teamId: string, input: TeamUpdateInput): Promise<TeamResponse> {
    const tenantId = this.tenantContext.requireTenantId();

    return this.prisma.$tenantTransaction(async (tx) => {
      const before = await tx.team.findUnique({
        where: { id: teamId },
        select: { id: true, name: true, members: { select: { userId: true } } },
      });

      if (before === null) {
        throw new TeamNotFoundError(teamId);
      }

      if (input.memberUserIds !== undefined) {
        await assertUsersExist(tx, tenantId, input.memberUserIds);
      }

      const team = await tx.team
        .update({
          where: { id: teamId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
          },
          select: TEAM_PROJECTION,
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) && input.name !== undefined
            ? new TeamNameTakenError(input.name)
            : error;
        });

      const membership =
        input.memberUserIds === undefined
          ? null
          : await replaceMembers(tx, tenantId, teamId, before.members, input.memberUserIds);

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.teamUpdated,
        targetType: 'team',
        targetId: teamId,
        metadata: {
          ...(input.name === undefined || input.name === before.name
            ? {}
            : { name: { from: before.name, to: input.name } }),
          ...(membership === null ? {} : { added: membership.added, removed: membership.removed }),
        },
      });

      if (membership !== null) {
        // Both directions: a new member gains a scope they did not have, and a
        // removed one keeps it until their session dies.
        await this.revokeFor(tx, tenantId, [...membership.added, ...membership.removed]);
      }

      return toTeamResponse(
        membership === null
          ? team
          : { ...team, members: input.memberUserIds?.map((userId) => ({ userId })) ?? [] },
      );
    });
  }

  private async revokeFor(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userIds: readonly string[],
  ): Promise<void> {
    for (const userId of userIds) {
      await this.sessions.revokeFor(tx, tenantId, userId, 'teams_change');
    }
  }
}

interface MembershipDelta {
  added: readonly string[];
  removed: readonly string[];
}

async function replaceMembers(
  tx: Prisma.TransactionClient,
  tenantId: string,
  teamId: string,
  current: readonly { userId: string }[],
  wantedIds: readonly string[],
): Promise<MembershipDelta> {
  const held = new Set(current.map((member) => member.userId));
  const wanted = new Set(wantedIds);

  const added = [...wanted].filter((userId) => !held.has(userId));
  const removed = [...held].filter((userId) => !wanted.has(userId));

  if (removed.length > 0) {
    await tx.teamMember.deleteMany({ where: { teamId, userId: { in: removed } } });
  }

  if (added.length > 0) {
    await tx.teamMember.createMany({
      data: added.map((userId) => ({ tenantId, teamId, userId })),
    });
  }

  return { added, removed };
}

/**
 * Rejects a member id that is not a user in this tenant.
 *
 * The composite key `(tenant_id, user_id)` is what actually stops tenant A
 * putting tenant B's agent in its team — RLS cannot, because the row carries A's
 * own `tenant_id` and satisfies the policy. This check exists so that attempt
 * answers `validation_failed` naming the id rather than a 500 from a constraint.
 */
async function assertUsersExist(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) {
    return;
  }

  const found = await tx.user.findMany({
    where: { tenantId, id: { in: [...userIds] } },
    select: { id: true },
  });
  const known = new Set(found.map((user) => user.id));
  const unknown = [...new Set(userIds)].filter((userId) => !known.has(userId));

  if (unknown.length > 0) {
    throw new UnknownReferenceError('user', unknown);
  }
}

function toPage(rows: readonly TeamRow[], limit: number): CursorPage<TeamResponse> {
  const items = rows.slice(0, limit);

  return {
    items: items.map(toTeamResponse),
    nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
