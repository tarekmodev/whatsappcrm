import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  isRoleWithin,
  type AgentAvailability,
  type CursorPage,
  type InviteCreateInput,
  type InviteResponse,
  type SessionPrincipal,
  type TenantRole,
  type UserListQuery,
  type UserResponse,
  type UserStatus,
  type UserUpdateInput,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { SessionRevocationService } from '../rbac/session-revocation.service';
import { toUserResponse, type UserRow } from './people.mapper';
import {
  EmailAlreadyRegisteredError,
  LastAdminRequiredError,
  RoleAssignmentNotPermittedError,
  RoleEscalationError,
  SelfRoleChangeError,
  UnknownReferenceError,
  UserNotFoundError,
} from './people.errors';

/** How long an invite is good for. Long enough for a holiday, short enough to expire. */
const INVITE_TTL_DAYS = 7;

/**
 * The columns a `UserResponse` is built from — and the reason this constant
 * exists rather than a `select: true` per call: `users` carries
 * `password_hash`, and the projection is what keeps it out of every query in
 * this file at once.
 */
const USER_PROJECTION = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  role: true,
  status: true,
  availability: true,
  lastSeenAt: true,
  createdAt: true,
  // Prisma resolves this as one batched `IN` over the page's users, not one
  // query per row, and it is served by TAR-80's `(tenant_id, user_id, team_id)`
  // index without touching the heap.
  teamMemberships: { select: { teamId: true } },
} as const satisfies Prisma.UserSelect;

/**
 * People management (TAR-22): the tenant's agents, supervisors and admins.
 *
 * Everything here runs on `TenantPrisma`, so every statement carries the
 * `app.tenant_id` GUC and is filtered by TAR-48's row-level security. The
 * service never takes a tenant id from a caller — there is no parameter for one
 * — which is what makes "no cross-tenant read or write under any role" a
 * property of the wiring rather than of remembering to add a filter.
 *
 * Role enforcement is layered, and the layers answer different questions:
 *
 *   * `PermissionGuard` — may this principal perform this operation at all?
 *   * this service — is the *resulting state* coherent? Permissions cannot
 *     express "not your own role", "not above your own" or "not the last admin",
 *     because those are about the target and the outcome rather than the caller.
 *
 * Every mutation that changes what somebody may do — role, status, teams —
 * revokes their sessions in the same transaction, so the change takes effect on
 * their next request rather than on their next login.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly sessions: SessionRevocationService,
  ) {}

  /**
   * The people list. Tenant-wide for every role, including `agent`: `user:read`
   * is granted to all three because the console cannot render an assignee name,
   * a "routed to" label or a mention without it. It exposes who works here, not
   * what they can see — conversation visibility is a separate predicate.
   *
   * Keyset paginated on `id`, which is a UUIDv7 and therefore already in
   * creation order: one column does the job of `(created_at, id)`, and the
   * primary key serves the scan.
   */
  async list(query: UserListQuery): Promise<CursorPage<UserResponse>> {
    const rows = await this.prisma.user.findMany({
      where: {
        ...(query.role === undefined ? {} : { role: query.role }),
        ...statusFilter(query.status),
        ...(query.teamId === undefined
          ? {}
          : { teamMemberships: { some: { teamId: query.teamId } } }),
        ...(query.q === undefined ? {} : searchFilter(query.q)),
        ...(query.cursor === undefined ? {} : { id: { lt: query.cursor } }),
      },
      select: USER_PROJECTION,
      orderBy: { id: 'desc' },
      // One more than the page, so "is there another page" costs a row rather
      // than a `count(*)` over the whole filtered set on every request.
      take: query.limit + 1,
    });

    return toPage(rows, query.limit);
  }

  /**
   * Invites somebody into the tenant.
   *
   * The `users` row is written **now**, in `invited` status with no password
   * hash, rather than at acceptance. Three things fall out of that and all of
   * them are wanted: the invitee appears in the people list immediately, their
   * team memberships are real `team_members` rows rather than an intention
   * parked somewhere, and `UNIQUE (tenant_id, email)` is what rejects a second
   * invite to an address that already has an account — instead of two pending
   * invites racing to create the same person.
   *
   * ⚠️ **The invite token is not deliverable yet.** A single-use token is
   * generated and only its hash is stored, which is correct, but sending it is
   * TAR-35's (invite email + `POST /auth/invites/accept`). Until that lands the
   * plaintext is discarded here — deliberately, because logging or returning a
   * credential to make it reachable would be worse than the gap. The durable
   * half is the row; TAR-35's resend path issues a token that can actually be
   * used.
   */
  async invite(input: InviteCreateInput): Promise<InviteResponse> {
    const principal = this.tenantContext.requirePrincipal();
    const tenantId = this.tenantContext.requireTenantId();

    this.assertMayAssign(input.role, principal);

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    return this.prisma.$tenantTransaction(async (tx) => {
      await assertTeamsExist(tx, tenantId, input.teamIds);

      const existing = await tx.user.findFirst({
        where: { email: input.email },
        select: { id: true, status: true, role: true },
      });

      if (existing !== null && existing.status !== 'invited') {
        throw new EmailAlreadyRegisteredError(input.email);
      }

      // Re-inviting somebody whose invite is still pending updates their role
      // and teams and issues a fresh token, rather than failing on the unique
      // key — which is what an admin who mistyped the role actually wants.
      const user =
        existing === null
          ? await tx.user.create({
              data: {
                tenantId,
                email: input.email,
                // The invitee sets their real name when they accept. A
                // placeholder rather than a nullable column: `name` is NOT NULL
                // and every list rendering it would otherwise need a fallback.
                name: input.email.split('@')[0] ?? input.email,
                role: input.role,
                status: 'invited',
              },
              select: { id: true },
            })
          : await tx.user.update({
              where: { id: existing.id },
              data: { role: input.role },
              select: { id: true },
            });

      await replaceTeamMemberships(tx, tenantId, user.id, input.teamIds);

      // One live invite per address per tenant. A re-invite replaces the token,
      // which also revokes the old one — a link mailed out by mistake stops
      // working the moment a new one is issued. Not an `upsert`: `invites` has
      // no unique key on `(tenant_id, email)` to upsert against, and adding one
      // is a schema change TAR-80 owns. The read and the write are in the same
      // transaction, and a lost race collides on `token_hash`'s unique index
      // rather than duplicating.
      const pending = await tx.invite.findFirst({
        where: { email: input.email, acceptedAt: null },
        select: { id: true },
      });

      const inviteFields = {
        role: input.role,
        tokenHash: hashToken(token),
        invitedByUserId: principal.userId,
        expiresAt,
      };
      const inviteProjection = {
        id: true,
        email: true,
        role: true,
        invitedByUserId: true,
        expiresAt: true,
        acceptedAt: true,
        createdAt: true,
      } as const;

      const invite =
        pending === null
          ? await tx.invite.create({
              data: { tenantId, email: input.email, ...inviteFields },
              select: inviteProjection,
            })
          : await tx.invite.update({
              where: { id: pending.id },
              data: inviteFields,
              select: inviteProjection,
            });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.userInvited,
        targetType: 'user',
        targetId: user.id,
        metadata: { role: input.role, teamIds: input.teamIds },
      });

      return {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        // Non-null in practice — an invite always has an inviter — but the
        // column is nullable for a future system-issued invite, so the response
        // reports the caller rather than asserting the column.
        invitedByUserId: invite.invitedByUserId ?? principal.userId,
        expiresAt: invite.expiresAt.toISOString(),
        acceptedAt: invite.acceptedAt?.toISOString() ?? null,
        createdAt: invite.createdAt.toISOString(),
      };
    });
  }

  /**
   * Changes somebody's name, role, status or team membership.
   *
   * `role` is the field with a second gate on it: the route needs `user:update`,
   * and a body carrying `role` additionally needs `user:set_role` (TAR-79,
   * delta 1). A caller without it is **refused**, not silently served with the
   * field dropped — a privilege change that appears to have succeeded is the
   * worse of the two failures.
   */
  async update(userId: string, input: UserUpdateInput): Promise<UserResponse> {
    const principal = this.tenantContext.requirePrincipal();
    const tenantId = this.tenantContext.requireTenantId();

    if (input.role !== undefined) {
      this.assertMayChangeRole(userId, input.role, principal);
    }

    const response = await this.prisma.$tenantTransaction(async (tx) => {
      const before = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, status: true, name: true },
      });

      if (before === null) {
        // Absent, or in another tenant — RLS makes the two indistinguishable,
        // which is the intent: a 403 here would confirm the id exists somewhere.
        throw new UserNotFoundError(userId);
      }

      if (leavesTenantWithoutAdmin(before, input)) {
        await assertAnotherActiveAdminExists(tx, tenantId, userId);
      }

      if (input.teamIds !== undefined) {
        await assertTeamsExist(tx, tenantId, input.teamIds);
      }

      const after = await tx.user.update({
        where: { id: userId },
        data: {
          ...(input.displayName === undefined ? {} : { name: input.displayName }),
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
        select: USER_PROJECTION,
      });

      const teamsChanged =
        input.teamIds === undefined
          ? null
          : await replaceTeamMemberships(tx, tenantId, userId, input.teamIds);

      await this.recordUserChanges(tx, tenantId, before, input, teamsChanged);

      return toUserResponse(
        // `teamMemberships` was read before the membership write, so it would
        // report the old set. Re-read rather than patch the object by hand.
        input.teamIds === undefined
          ? after
          : { ...after, teamMemberships: input.teamIds.map((teamId) => ({ teamId })) },
      );
    });

    // The second cache purge, after the commit. See `SessionRevocationService`
    // for why one before the write is not enough, and why this is unconditional
    // rather than gated on whether anything was actually revoked.
    await this.sessions.purgeCacheFor(tenantId, userId);

    return response;
  }

  /**
   * Removes a user: `status: 'removed'`, every session killed, every team left,
   * every routing reference cleared. Admin-only, audited, and idempotent.
   *
   * **A status change rather than a `DELETE FROM users`,** which is the one
   * design decision in this file worth arguing about. Ten tables carry a
   * nullable `ON DELETE NO ACTION` foreign key to `users`. Six of them are
   * routing — assignments, rules, the round-robin cursor, who sent an invite —
   * and clearing those is exactly TAR-79's invariant 4, done below. The other
   * four are *history*: `messages.sender_user_id`, `internal_notes`,
   * `ticket_events` and `audit_logs.actor_user_id`. A hard delete has to null
   * those too, and that is the deletion quietly rewriting the record of what
   * happened — on `audit_logs`, the record a SOC 2 style review asks for.
   *
   * The schema already anticipated this: `user_status` carries a `removed`
   * value that the contract had never published. So `DELETE /users/{id}`
   * answers 204 and the account is gone from every screen — delisted, logged
   * out, unassignable, not occupying a seat — while what they did is still
   * attributable. A tenant that needs the row itself erased is a data-subject
   * erasure request, which is a different operation with a different legal
   * shape, and it belongs with the tenant-deletion path rather than here.
   *
   * ⚠️ Flagged for TAR-79/TAR-84 as a deviation from "delete" read literally.
   */
  async remove(userId: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();

    await this.prisma.$tenantTransaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, role: true, status: true },
      });

      if (user === null) {
        throw new UserNotFoundError(userId);
      }

      if (user.status === 'removed') {
        // Idempotent: a retried DELETE is a no-op rather than a second audit
        // row claiming the same person was removed twice.
        return;
      }

      if (user.role === 'admin' && user.status === 'active') {
        await assertAnotherActiveAdminExists(tx, tenantId, userId);
      }

      // Invariant 4: clear the routing references, so nothing is left pointing
      // at somebody who is gone. Bounded by what one person holds open and by
      // how many rules and snippets they wrote — never by message history.
      //
      // Sequential rather than `Promise.all`: these share one transaction and
      // therefore one connection, and interleaving statements on it is how an
      // out-of-order rollback surfaces in production and never in a unit test.
      const conversations = await tx.conversation.updateMany({
        where: { assignedUserId: userId },
        data: { assignedUserId: null },
      });
      const tickets = await tx.ticket.updateMany({
        where: { assignedUserId: userId },
        data: { assignedUserId: null },
      });
      await tx.assignmentState.updateMany({
        where: { lastAssignedUserId: userId },
        data: { lastAssignedUserId: null },
      });
      await tx.assignmentRule.updateMany({
        where: { targetUserId: userId },
        // A rule that routed to this person routes nowhere now. Deactivated
        // rather than deleted: a supervisor should find the rule needing a new
        // target, not find it silently gone.
        data: { targetUserId: null, isActive: false },
      });
      // Team membership goes with them, so they disappear from every team
      // picker and stop widening anybody's `teamIds`.
      await tx.teamMember.deleteMany({ where: { userId } });

      await tx.user.update({
        where: { id: userId },
        data: { status: 'removed', availability: 'offline' },
        select: { id: true },
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.userRemoved,
        targetType: 'user',
        targetId: userId,
        metadata: {
          email: user.email,
          roleAtRemoval: user.role,
          assignmentsCleared: conversations.count + tickets.count,
        },
      });

      await this.sessions.revokeFor(tx, tenantId, userId, 'removed');
    });

    await this.sessions.purgeCacheFor(tenantId, userId);

    this.logger.log(`Removed user ${userId}`);
  }

  /**
   * `PATCH /users/me/availability`. No permission: the resource is the caller.
   *
   * Deliberately not reachable for anybody else's availability. Auto-assignment
   * (TAR-23) skips an `away` agent, so setting somebody else's would be a way to
   * route work off a colleague — a supervisor who wants that changes their
   * status or their teams instead, both of which are audited.
   */
  async setOwnAvailability(availability: AgentAvailability): Promise<UserResponse> {
    const principal = this.tenantContext.requirePrincipal();

    const row = await this.prisma.user.update({
      where: { id: principal.userId },
      data: { availability },
      select: USER_PROJECTION,
    });

    return toUserResponse(row);
  }

  /**
   * What role an invite may carry (TAR-79, delta 1).
   *
   * A caller holding `user:invite` but not `user:set_role` may invite an
   * `agent` and nothing else. That single rule is what closes the live
   * escalation path in the shipped contract: `InviteCreateInputSchema.role`
   * accepts any role, so without it a supervisor could mint an admin, accept
   * nothing, and have that account administer billing and the WhatsApp
   * credentials.
   */
  private assertMayAssign(role: TenantRole, principal: SessionPrincipal): void {
    if (!principal.permissions.includes('user:set_role')) {
      if (role !== 'agent') {
        throw new RoleAssignmentNotPermittedError(role);
      }
      return;
    }

    if (!isRoleWithin(role, principal.role)) {
      throw new RoleEscalationError(role, principal.role);
    }
  }

  /** Invariants 1 and 2, applied to a role write on an existing user. */
  private assertMayChangeRole(userId: string, role: TenantRole, principal: SessionPrincipal): void {
    if (userId === principal.userId) {
      // Including an admin. Every escalation then needs a second person, and
      // the commonest self-lockout — an admin demoting themselves — is gone.
      // Checked before the permission, so an admin editing their own role gets
      // the reason that is actually true rather than a generic refusal.
      throw new SelfRoleChangeError();
    }

    if (!principal.permissions.includes('user:set_role')) {
      throw new RoleAssignmentNotPermittedError(role);
    }

    if (!isRoleWithin(role, principal.role)) {
      throw new RoleEscalationError(role, principal.role);
    }
  }

  /**
   * One audit row per thing that actually changed, plus one session revocation
   * if any of them affects what the user may do.
   */
  private async recordUserChanges(
    tx: Prisma.TransactionClient,
    tenantId: string,
    before: { id: string; role: TenantRole; status: UserStatus; name: string },
    input: UserUpdateInput,
    teamsChanged: TeamMembershipDelta | null,
  ): Promise<void> {
    const roleChanged = input.role !== undefined && input.role !== before.role;
    const statusChanged = input.status !== undefined && input.status !== before.status;
    const membershipChanged = teamsChanged !== null && teamsChanged.changed;

    if (roleChanged) {
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.userRoleChanged,
        targetType: 'user',
        targetId: before.id,
        metadata: { from: before.role, to: input.role },
      });
    }

    if (statusChanged) {
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.userStatusChanged,
        targetType: 'user',
        targetId: before.id,
        metadata: { from: before.status, to: input.status },
      });
    }

    if (membershipChanged) {
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.userTeamsChanged,
        targetType: 'user',
        targetId: before.id,
        metadata: { added: teamsChanged.added, removed: teamsChanged.removed },
      });
    }

    if (input.displayName !== undefined && input.displayName !== before.name) {
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.userProfileChanged,
        targetType: 'user',
        targetId: before.id,
        // The name is the thing that changed and is already visible to everyone
        // in the tenant, so recording it discloses nothing new.
        metadata: { from: before.name, to: input.displayName },
      });
    }

    // One revocation, whichever of the three fired: `permissions` and `teamIds`
    // are both materialised onto the principal at resolution, so any of them
    // leaves an active session describing a person who no longer exists.
    const reason = roleChanged
      ? 'role_change'
      : statusChanged
        ? 'status_change'
        : membershipChanged
          ? 'teams_change'
          : null;

    if (reason !== null) {
      await this.sessions.revokeFor(tx, tenantId, before.id, reason);
    }
  }
}

export interface TeamMembershipDelta {
  added: readonly string[];
  removed: readonly string[];
  changed: boolean;
}

/**
 * Replaces a user's team memberships with exactly `teamIds`, and reports what
 * moved so the caller can audit it.
 *
 * A replace rather than an add/remove pair, matching `UserUpdateInput.teamIds`:
 * the client sends the membership it wants, not a delta it computed against a
 * list it may have read minutes ago.
 */
async function replaceTeamMemberships(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  teamIds: readonly string[],
): Promise<TeamMembershipDelta> {
  const current = await tx.teamMember.findMany({ where: { userId }, select: { teamId: true } });
  const held = new Set(current.map((membership) => membership.teamId));
  const wanted = new Set(teamIds);

  const added = [...wanted].filter((teamId) => !held.has(teamId));
  const removed = [...held].filter((teamId) => !wanted.has(teamId));

  if (removed.length > 0) {
    await tx.teamMember.deleteMany({ where: { userId, teamId: { in: removed } } });
  }

  if (added.length > 0) {
    await tx.teamMember.createMany({
      data: added.map((teamId) => ({ tenantId, teamId, userId })),
    });
  }

  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

/**
 * Rejects any id that is not a team in this tenant.
 *
 * The composite foreign key `(tenant_id, team_id)` would refuse the write
 * anyway — that is TAR-80's guarantee and the one that actually holds — but a
 * constraint violation surfaces as a 500. This turns "team 9f… does not exist"
 * into a `validation_failed` naming the ids, which is what the caller can act on.
 */
async function assertTeamsExist(
  tx: Prisma.TransactionClient,
  tenantId: string,
  teamIds: readonly string[],
): Promise<void> {
  if (teamIds.length === 0) {
    return;
  }

  const found = await tx.team.findMany({
    where: { tenantId, id: { in: [...teamIds] } },
    select: { id: true },
  });
  const known = new Set(found.map((team) => team.id));
  const unknown = [...new Set(teamIds)].filter((teamId) => !known.has(teamId));

  if (unknown.length > 0) {
    throw new UnknownReferenceError('team', unknown);
  }
}

/** True when the requested change takes the target out of the active-admin set. */
function leavesTenantWithoutAdmin(
  before: { role: TenantRole; status: UserStatus },
  input: UserUpdateInput,
): boolean {
  if (before.role !== 'admin' || before.status !== 'active') {
    return false;
  }

  const demoted = input.role !== undefined && input.role !== 'admin';
  const deactivated = input.status !== undefined && input.status !== 'active';

  return demoted || deactivated;
}

/**
 * Invariant 3. Locks the tenant's active admins, then checks that at least one
 * other one survives.
 *
 * `FOR UPDATE` on the whole set, not on the target: two concurrent demotions of
 * two different admins would otherwise each read "one other admin exists" and
 * both commit, leaving zero. Under `READ COMMITTED` Postgres re-evaluates the
 * predicate after granting the lock, so the second transaction sees the first
 * one's demotion and refuses — which is the entire reason this is a locking read
 * rather than a `count()`.
 *
 * A tenant with no admin cannot manage billing, branding or its WhatsApp
 * credentials, and can only be recovered by platform support. That is why it is
 * a 409 an operator can act on rather than something left to a support ticket.
 */
async function assertAnotherActiveAdminExists(
  tx: Prisma.TransactionClient,
  tenantId: string,
  excludingUserId: string,
): Promise<void> {
  const admins = await tx.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM users
    WHERE tenant_id = ${tenantId}::uuid
      AND role = 'admin'
      AND status = 'active'
    FOR UPDATE
  `;

  if (!admins.some((admin) => admin.id !== excludingUserId)) {
    throw new LastAdminRequiredError();
  }
}

/** `name` is searched case-insensitively; `email` is `citext`, so it already is. */
function searchFilter(q: string): Prisma.UserWhereInput {
  return {
    OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q } }],
  };
}

function toPage(rows: readonly UserRow[], limit: number): CursorPage<UserResponse> {
  const items = rows.slice(0, limit);

  return {
    // Arrow, not a bare reference: `map` would pass the index as the second
    // argument, which is `security` (TAR-53). The list omits lockout state —
    // `user:read` is an agent permission, and only `user:update` may see it.
    items: items.map((row) => toUserResponse(row)),
    nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  };
}

/**
 * Removed accounts are absent unless asked for by name. A soft delete that
 * still shows up in the people list, an assignee picker or a mention menu is a
 * soft delete nobody trusts.
 */
function statusFilter(status: UserStatus | undefined): Prisma.UserWhereInput {
  return status === undefined ? { status: { not: 'removed' } } : { status };
}

function hashToken(token: string): string {
  // The plaintext is what goes in the email; only this ever touches the
  // database, so a dump of `invites` grants nobody an account. SHA-256 rather
  // than a password hash: the token is 256 bits of machine-generated entropy,
  // so there is nothing for a work factor to protect against.
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
