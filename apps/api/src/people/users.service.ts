import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  type AgentAvailability,
  type AgentCapacity,
  type CursorPage,
  type SessionPrincipal,
  type TenantRole,
  type UserListQuery,
  type UserResponse,
  type UserStatus,
  type UserUpdateInput,
  type UserUpdateResponse,
  type WorkflowBrokenReason,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { SEATS_CHANGED_EVENT, type SeatsChangedEvent } from '../events/domain-events';
import { Prisma } from '../generated/prisma/client';
import { LoginThrottleService } from '../identity/login-throttle.service';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { SessionRevocationService } from '../rbac/session-revocation.service';
import {
  readActiveTicketCounts,
  readTenantCapacityDefault,
  toAgentCapacity,
} from './agent-capacity';
import {
  toUserResponse,
  type UserCapacityRow,
  type UserRow,
  type UserSecurityRow,
} from './people.mapper';
import {
  CapacityChangeNotPermittedError,
  LastAdminRequiredError,
  SelfRoleChangeError,
  UserNotFoundError,
} from './people.errors';
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
  // One more scalar out of the same tuple, gated the same way (TAR-384): the
  // response field is assembled by `capacityFor`, which returns `null` for a
  // caller who may not see it, so widening the projection widens no response.
  maxConcurrentTickets: true,
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
    private readonly events: EventEmitter2,
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

    // Bounded by `take` above — at most `limit + 1` ids, and `limit` is capped
    // at 100 by `CursorPageQuerySchema`. Two extra statements for a caller who
    // may see the field, and none at all for an agent.
    const capacities = await this.capacitiesFor(rows.slice(0, query.limit));

    return toPage(rows, query.limit, this.maySeeSecurity(), capacities);
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
  async update(userId: string, input: UserUpdateInput): Promise<UserUpdateResponse> {
    const principal = this.tenantContext.requirePrincipal();
    const tenantId = this.tenantContext.requireTenantId();

    if (input.role !== undefined) {
      this.assertMayChangeRole(userId, input.role, principal);
    }

    // Read here, checked inside the transaction once the target row exists.
    // `@RequirePermission` metadata is static and this condition depends on the
    // body, which is why the guard cannot express it — the same reason `role`
    // is enforced in this service (TAR-79, delta 1).
    const mayWriteCapacity = principal.permissions.includes('assignment_rule:write');

    const { response, after } = await this.prisma.$tenantTransaction(async (tx) => {
      const before = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, status: true, name: true, maxConcurrentTickets: true },
      });

      if (before === null) {
        // Absent, or in another tenant — RLS makes the two indistinguishable,
        // which is the intent: a 403 here would confirm the id exists somewhere.
        throw new UserNotFoundError(userId);
      }

      // After the row is resolved, deliberately: a caller without the
      // permission patching an id that does not exist gets `not_found`, because
      // a 403 on an unknown id is an existence oracle (TAR-384). The order is
      // validate → resolve (404) → permission-on-field (403) → invariants (409)
      // → write, and it is stated here because two implementations of it would
      // eventually disagree.
      if (input.maxConcurrentTickets !== undefined && !mayWriteCapacity) {
        throw new CapacityChangeNotPermittedError();
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
          // `undefined` leaves the override alone; an explicit `null` clears it
          // and returns the agent to the tenant default. The two are distinct
          // and the spread is what keeps them so.
          ...(input.maxConcurrentTickets === undefined
            ? {}
            : { maxConcurrentTickets: input.maxConcurrentTickets }),
        },
        select: USER_PROJECTION,
      });

      const teamsChanged =
        input.teamIds === undefined
          ? null
          : await replaceTeamMemberships(tx, tenantId, userId, input.teamIds);

      // The same cascade the removal path runs, on the other transition that
      // makes a user unusable to the automation engine (TAR-596).
      //
      // `USER_WRITABLE_STATUSES` is `['active', 'suspended']`, so the only
      // status this route can write that a workflow may not name is
      // `suspended` — and an armed workflow can only name an *active* user,
      // because `REFERENCEABLE_USER` is what arming resolves against. So this
      // fires on exactly the transition that creates a dangling actor.
      const workflowsDisarmed =
        input.status === 'suspended' && before.status !== 'suspended'
          ? await disarmWorkflowsNaming(tx, userId, 'reference_suspended')
          : 0;

      await this.recordUserChanges(tx, tenantId, before, input, teamsChanged, workflowsDisarmed);

      return {
        response: {
          ...toUserResponse(
            // `teamMemberships` was read before the membership write, so it
            // would report the old set. Re-read rather than patch the object by
            // hand.
            input.teamIds === undefined
              ? after
              : { ...after, teamMemberships: input.teamIds.map((teamId) => ({ teamId })) },
            this.securityFor(after),
          ),
          // TAR-605. Reported rather than notified — `UserUpdateResponseSchema`
          // holds the argument. Always present, `0` on the requests that
          // disarmed nothing, so a client reads one field instead of inferring
          // from `status`.
          workflowsDisarmed,
        },
        after,
      };
    });

    // The second cache purge, after the commit. See `SessionRevocationService`
    // for why one before the write is not enough, and why this is unconditional
    // rather than gated on whether anything was actually revoked.
    await this.sessions.purgeCacheFor(tenantId, userId);

    // The committed row, so a caller who just raised a cap is told the number
    // they set — and read outside the transaction, because counting somebody's
    // open tickets is not part of the write.
    return { ...response, assignmentCapacity: await this.capacityFor(after) };
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
      // The same rule for workflows (TAR-27, 0009 decision 6, delta 5) — see
      // `disarmWorkflowsNaming` for why it disarms rather than deletes. It has
      // to happen here rather than through a foreign key: `workflow_references`
      // permits a user delete on purpose, because removal is a security action
      // that must **always** succeed — where a tag or team delete is refused by
      // the constraint precisely so a supervisor is told before anything breaks.
      const workflowsDisarmed = await disarmWorkflowsNaming(tx, userId, 'reference_removed');

      if (workflowsDisarmed > 0) {
        // The reverse index drops the rows naming this user, so the next
        // "which workflows use this?" lookup is accurate. The composite foreign
        // key is `NoAction`, so this is what makes the removal legal at all.
        //
        // **Removal only.** A suspension leaves these rows standing: the account
        // is still there, still reinstatable, and the workflow still names it —
        // dropping them would make the console's `references` array claim the
        // definition points at nothing and lose the id the admin has to repair.
        await tx.workflowReference.deleteMany({ where: { userId } });
      }

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
          workflowsDisarmed,
        },
      });

      await this.sessions.revokeFor(tx, tenantId, userId, 'removed');
    });

    await this.sessions.purgeCacheFor(tenantId, userId);

    // After the commit, and emitted rather than called: the seat this released
    // is a billing fact, and whether anyone is charged for it is a question this
    // module must not be able to answer. TAR-37 subscribes. Removal only ever
    // *reduces* the count, and reductions are deferred to the end of the paid
    // period by the subscriber — so this is a durable record of the change
    // rather than an immediate credit.
    this.events.emit(SEATS_CHANGED_EVENT, {
      tenantId,
      cause: 'member_removed',
    } satisfies SeatsChangedEvent);

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
   *
   * Clears **both** counters that can refuse this account: the durable columns,
   * and the Redis lockout keyed by the address. Leaving the second would make
   * "let them back in now" mean "in up to fifteen minutes", which is the
   * complaint the endpoint exists to answer. It hands an attacker nothing the
   * durable reset does not — that already restores a full allowance of guesses.
   * The per-client-address window is a different matter and is deliberately
   * untouched: that one belongs to whoever was guessing, not to the account.
   */
  async unlock(userId: string): Promise<UserResponse> {
    const tenantId = this.tenantContext.requireTenantId();

    const { response, row } = await this.prisma.$tenantTransaction(async (tx) => {
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
      return { response: toUserResponse(row, { lockedUntil: null, failedLoginAttempts: 0 }), row };
    });

    // After the commit, and unconditional: clearing a lock that was not set
    // costs one Redis `DEL`, while skipping one that was would leave the
    // account refused by a layer the admin cannot see.
    await this.loginThrottle.clearEmailFailures(tenantId, response.email);

    // Gated on its own permission, unlike `security` above: `user:update` and
    // `assignment_rule:read` are not the same question, and a future role could
    // hold one without the other.
    return { ...response, assignmentCapacity: await this.capacityFor(row) };
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

    return toUserResponse(row, this.securityFor(row), await this.capacityFor(row));
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

  /**
   * Whether the caller may be told a colleague's workload at all (TAR-384).
   *
   * `read` **or** `write`, not `read` alone: a role granted write without read
   * would otherwise set a cap and be handed `null` back. `user:read` is held by
   * every agent, so gating on the route's own permission would publish a live
   * readout of a named colleague's load — and how close they are to being cut
   * off from work — to the whole tenant.
   */
  private maySeeCapacity(): boolean {
    const { permissions } = this.tenantContext.requirePrincipal();

    return (
      permissions.includes('assignment_rule:read') || permissions.includes('assignment_rule:write')
    );
  }

  /**
   * The capacity block for a set of rows, keyed by user id — empty for a caller
   * who may not see it, which is what makes the two extra statements cost an
   * agent nothing.
   */
  private async capacitiesFor(
    rows: readonly (UserCapacityRow & { id: string })[],
  ): Promise<ReadonlyMap<string, AgentCapacity>> {
    if (rows.length === 0 || !this.maySeeCapacity()) {
      return new Map();
    }

    const tenantId = this.tenantContext.requireTenantId();
    const [tenantDefault, counts] = await Promise.all([
      readTenantCapacityDefault(this.prisma, tenantId),
      readActiveTicketCounts(
        this.prisma,
        tenantId,
        rows.map((row) => row.id),
      ),
    ]);

    return new Map(
      rows.map((row) => [
        row.id,
        toAgentCapacity(row.maxConcurrentTickets, tenantDefault, counts.get(row.id) ?? 0),
      ]),
    );
  }

  /**
   * The same, for the single row every write path answers with.
   *
   * Called **after** the write transaction commits, never inside it: these are
   * two reads that have no business holding a write connection open, and the
   * number they produce has to reflect the committed row.
   */
  private async capacityFor(row: UserCapacityRow & { id: string }): Promise<AgentCapacity | null> {
    return (await this.capacitiesFor([row])).get(row.id) ?? null;
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
    before: {
      id: string;
      role: TenantRole;
      status: UserStatus;
      name: string;
      maxConcurrentTickets: number | null;
    },
    input: UserUpdateInput,
    teamsChanged: TeamMembershipDelta | null,
    workflowsDisarmed: number,
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
        // `workflowsDisarmed` is the side effect the admin did not ask for and
        // has to know about: suspending one person can switch off automation the
        // whole tenant relies on. Recorded on the row that caused it rather than
        // left to be reconstructed from `workflow.deactivated` timestamps.
        metadata: { from: before.status, to: input.status, workflowsDisarmed },
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

    if (
      input.maxConcurrentTickets !== undefined &&
      input.maxConcurrentTickets !== before.maxConcurrentTickets
    ) {
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.userCapacityChanged,
        targetType: 'user',
        targetId: before.id,
        // Two integers, either of which may be `null` for "inherits the tenant
        // default". No PII, and enough to answer "who throttled this agent, and
        // from what?" six months later.
        metadata: { from: before.maxConcurrentTickets, to: input.maxConcurrentTickets },
      });
    }

    // One revocation, whichever of the three fired: `permissions` and `teamIds`
    // are both materialised onto the principal at resolution, so any of them
    // leaves an active session describing a person who no longer exists.
    //
    // A cap change is deliberately **not** one of them (TAR-384): it alters how
    // much work reaches somebody, not what they may do, and the principal
    // carries no cap to go stale — rotation reads the column per job.
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
 * Disarms every workflow naming this user, and reports how many (TAR-27, 0009
 * decision 6, delta 5; extended to suspension by TAR-596).
 *
 * **Two callers, one implementation, because the rule is one rule**: a workflow
 * may only name an *active* user — `REFERENCEABLE_USER` is the predicate both
 * arming and the executor resolve against — so any transition out of `active`
 * leaves an armed workflow pointing at an actor the executor will refuse to use.
 * Left alone, the first ticket that reaches such a workflow fails
 * `reference_missing` and auto-deactivates it anyway; doing it here means the
 * admin who caused it is told by the audit trail rather than by a customer.
 *
 * Deactivated with a reason rather than deleted, matching the assignment rule
 * beside it: a supervisor should find the workflow needing a new target, not
 * find it silently gone. `broken_reason` is what blocks re-arming until the
 * reference resolves again, and `workflows_broken_is_inactive` makes the pairing
 * structural — which is why both columns move in one statement.
 *
 * The dangling id stays in `definition` deliberately: the workflow's
 * `references` array then reports `exists: false` and the console shows exactly
 * which field needs a new value.
 *
 * `reference_removed` overwrites `reference_suspended` when a suspended user is
 * later removed, and that is the right way round — the more permanent fact wins,
 * and the update is unconditional rather than filtered on `broken_reason` so a
 * workflow already broken for a different reason is not silently left claiming
 * the old one.
 *
 * Two indexed statements: the reverse index by `user_id`, and one `updateMany`
 * over the ids it returned. Bounded by `workflowsPerTenant`, never by history.
 */
async function disarmWorkflowsNaming(
  tx: Prisma.TransactionClient,
  userId: string,
  reason: WorkflowBrokenReason,
): Promise<number> {
  const naming = await tx.workflowReference.findMany({
    where: { userId },
    select: { workflowId: true },
  });

  if (naming.length === 0) {
    return 0;
  }

  const { count } = await tx.workflow.updateMany({
    where: { id: { in: naming.map((reference) => reference.workflowId) } },
    data: { isActive: false, brokenReason: reason },
  });

  return count;
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
  capacities: ReadonlyMap<string, AgentCapacity>,
): CursorPage<UserResponse> {
  const items = rows.slice(0, limit);

  return {
    // Arrow, not a bare reference: `map` would pass the index as the second
    // argument, which is `security` (TAR-53).
    items: items.map((row) =>
      toUserResponse(row, withSecurity ? row : null, capacities.get(row.id) ?? null),
    ),
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
