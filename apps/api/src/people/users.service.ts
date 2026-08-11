import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AgentAvailability,
  type CursorPage,
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
import { LoginThrottleService } from '../identity/login-throttle.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { SessionRevocationService } from '../rbac/session-revocation.service';
import { toUserResponse, type UserRow, type UserSecurityRow } from './people.mapper';
import { LastAdminRequiredError, SelfRoleChangeError, UserNotFoundError } from './people.errors';
import { assertRoleAssignable } from './role-assignment';
import { assertTeamsExist } from './team-references';

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
  // Two more scalars out of a tuple already being read, so this costs no extra
  // I/O — and the projection is not what gates them. `toUserResponse` takes the
  // security state as a *separate argument*, so a handler that forgets the
  // permission check gets `null` rather than a leak, and the alternative — a
  // conditional `select` — would make the row type a union at every call site
  // for nothing.
  lockedUntil: true,
  failedLoginAttempts: true,
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
    private readonly loginThrottle: LoginThrottleService,
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

    return toPage(rows, query.limit, this.maySeeSecurity());
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
        this.securityFor(after),
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

      // The outstanding invitation dies with the account.
      //
      // Without this, removing somebody who had been invited but had not yet
      // accepted leaves their emailed link live: `InviteService.activateAccount`
      // refuses only `active` and `suspended`, so a `removed` row falls through
      // to the update branch and is set back to `active` with the invited role
      // and the lockout counters cleared — reinstated by whoever holds the link,
      // with no admin action and no authentication beyond holding it.
      //
      // Revoked rather than deleted, so the trail still shows the invitation was
      // issued and how it ended. Matched by address rather than by
      // `invites.email = users.email` in SQL because both are `citext` on the
      // same tenant and the partial unique index already guarantees at most one
      // live row per address.
      const invitesRevoked = await tx.invite.updateMany({
        where: { tenantId, email: user.email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

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
          invitesRevoked: invitesRevoked.count,
        },
      });

      await this.sessions.revokeFor(tx, tenantId, userId, 'removed');
    });

    await this.sessions.purgeCacheFor(tenantId, userId);

    this.logger.log(`Removed user ${userId}`);
  }

  /**
   * `POST /users/{id}/unlock` — clears a brute-force lockout (TAR-59).
   *
   * The counterpart to the lockout being *visible*: an admin who can see that
   * an agent is locked out needs a way to let them back in before the window
   * elapses, otherwise "observable" means "watch them wait". `user:update`,
   * the same permission that reveals the state.
   *
   * Idempotent, and audited only when it actually cleared something. It does
   * not revoke sessions and does not touch the password: an account is locked
   * because somebody was guessing, which says nothing about whether the
   * credential is still good.
   */
  async unlock(userId: string): Promise<UserResponse> {
    return this.prisma.$tenantTransaction(async (tx) => {
      const row = await tx.user.findUnique({ where: { id: userId }, select: USER_PROJECTION });

      if (row === null) {
        // Absent, or in another tenant — RLS makes the two indistinguishable.
        throw new UserNotFoundError(userId);
      }

      const cleared = await this.loginThrottle.clearAccountLock(tx, userId);

      if (cleared) {
        await this.audit.record(tx, {
          action: AUDIT_ACTIONS.authUnlock,
          targetType: 'user',
          targetId: userId,
          // What was cleared, so the trail distinguishes "unlocked a locked
          // account" from "reset a counter that was creeping up".
          metadata: {
            failedAttemptsCleared: row.failedLoginAttempts,
            wasLockedUntil: row.lockedUntil?.toISOString() ?? null,
          },
        });

        this.logger.log(`Unlocked user ${userId}`);
      }

      // The post-state, which this transaction just wrote — not a second read.
      // Never gated: the route requires `user:update`, so a caller who reached
      // it may see it by definition.
      return toUserResponse(row, { lockedUntil: null, failedLoginAttempts: 0 });
    });
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

    return toUserResponse(row, this.securityFor(row));
  }

  /**
   * Whether the caller may be told about lockout state at all (TAR-53).
   *
   * `user:read` is held by every agent, so flat lockout fields on a people list
   * would give anyone in the tenant a live readout of how close a named
   * colleague is to being locked out, and confirmation when it lands. TAR-35
   * asks for a lockout observable to a tenant *admin* — which in the permission
   * vocabulary is whoever may administer that person, `user:update`.
   */
  private maySeeSecurity(): boolean {
    return this.tenantContext.requirePrincipal().permissions.includes('user:update');
  }

  /** The security state to publish for one row: the real thing, or nothing. */
  private securityFor(row: UserSecurityRow): UserSecurityRow | null {
    return this.maySeeSecurity() ? row : null;
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

    // Delta 1 and invariant 2, shared with the invite path so the two cannot
    // drift: whoever may grant a role may grant it in both places or neither.
    assertRoleAssignable(role, principal);
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

function toPage(
  rows: readonly (UserRow & UserSecurityRow)[],
  limit: number,
  withSecurity: boolean,
): CursorPage<UserResponse> {
  const items = rows.slice(0, limit);

  return {
    // Arrow, not a bare reference: `map` would pass the index as the second
    // argument, which is `security` (TAR-53).
    items: items.map((row) => toUserResponse(row, withSecurity ? row : null)),
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
