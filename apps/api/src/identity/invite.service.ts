import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUTH_POLICY,
  type CursorPage,
  type InviteAcceptInput,
  type InviteCreateInput,
  type InviteListQuery,
  type InvitePreviewResponse,
  type InviteResponse,
  type MailerPort,
  type SessionPrincipal,
  type TenantRole,
  permissionsForRole,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import { EmailAlreadyRegisteredError } from '../people/people.errors';
import { assertRoleAssignable } from '../people/role-assignment';
import { assertTeamsExist } from '../people/team-references';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { uuidV7 } from '../prisma/uuid-v7';
import { generateAuthToken, hashAuthToken } from './auth-tokens';
import {
  InviteNotFoundError,
  InviteNotPendingError,
  InviteTokenInvalidError,
  type TokenRejectionReason,
} from './identity.errors';
import { LoginThrottleService } from './login-throttle.service';
import { MAILER } from './mailer/mailer.port';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

/** The path the emailed link points at. The console renders the accept screen there. */
const INVITE_LINK_PATH = '/invite';

/** Where the request came from. Forensics on the session row, never a filter. */
export interface SessionOrigin {
  ipAddress: string | null;
  userAgent: string | null;
}

/** What `POST /api/v1/invites/accept` hands back: the body, plus the cookie's plaintext. */
export interface AcceptedInvite {
  principal: SessionPrincipal;
  /** For `Set-Cookie` only. Never rendered into a response body. */
  sessionToken: string;
}

/** `201` when a row was written, `200` when a live invite was refreshed instead. */
export interface CreatedInvite {
  invite: InviteResponse;
  created: boolean;
}

/**
 * Invitations: how somebody who has never signed in gets an account inside one
 * tenant, with the role an admin chose (TAR-55, ADR 0005).
 *
 * ## The three properties this file exists to hold
 *
 *   * **The tenant and the role come from the invite, never from the request.**
 *     `InviteAcceptInput` carries a token, a display name and a password — there
 *     is no tenant field and no role field for a caller to set. The tenant is the
 *     one `HostTenantGuard` resolved from the host, RLS then confines every
 *     statement below to it, and the role is read out of the row the token
 *     matched.
 *   * **A token is single-use because a *statement* says so.** Acceptance is a
 *     conditional `UPDATE … WHERE accepted_at IS NULL … RETURNING`; two
 *     simultaneous uses of one link mean the second updates zero rows and is
 *     refused. A read-then-write would let both through and create two accounts.
 *   * **Only digests are stored.** The plaintext token exists in the email and
 *     nowhere else — not in the response, not in an audit row, not in a log line.
 *
 * Everything runs on `TenantPrisma`, including the unauthenticated lookup and
 * accept paths: ADR 0005's amendment 1 puts the tenant in scope from the host
 * before authentication, so no auth flow needs `SystemPrisma` and a token from
 * tenant A presented at tenant B's host matches zero rows rather than being
 * compared in application code somebody could forget to write.
 */
@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    @Inject(MAILER) private readonly mailer: MailerPort,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly loginThrottle: LoginThrottleService,
  ) {}

  /**
   * Invites an address into the tenant, or refreshes the invitation it already
   * has.
   *
   * **Re-inviting is never a conflict.** The partial unique index
   * `invites_one_live_per_email` cannot carry an expiry term — Postgres requires
   * an index predicate to be `IMMUTABLE` — so a lapsed invite still occupies it.
   * Inserting beside it would fail, and an admin whose first invite went stale
   * would find the address permanently un-invitable through any self-service
   * path. The upsert below is what stops that: same row, new token, new expiry,
   * and the role and teams the admin just asked for, because that is their
   * current intent. Only an address that already has a usable account is a
   * `conflict`.
   *
   * A `users` row is written now, in `invited` status with no password hash,
   * rather than at acceptance. That is the shape the rest of the product already
   * assumes — the invitee is in the people list, `occupiesSeat` is false for
   * them, and `UNIQUE (tenant_id, email)` is what makes "one account per address"
   * a constraint rather than a check. Their **teams** are the deliberate
   * exception: they live in `invite_teams` until acceptance, so somebody who
   * never accepts never widens a team's membership.
   */
  async create(input: InviteCreateInput): Promise<CreatedInvite> {
    const principal = this.tenantContext.requirePrincipal();
    const tenantId = this.tenantContext.requireTenantId();

    assertRoleAssignable(input.role, principal);

    const token = generateAuthToken();
    const expiresAt = new Date(Date.now() + AUTH_POLICY.inviteTtlMs);

    const created = await this.prisma.$tenantTransaction(async (tx) => {
      await assertTeamsExist(tx, tenantId, input.teamIds);
      await this.reserveAccount(tx, tenantId, input.email, input.role);

      // Raw SQL because Prisma cannot express `ON CONFLICT` against a *partial*
      // unique index, and `invites_one_live_per_email` is one. The returned
      // `inserted` flag is Postgres' own `xmax`, which stays at zero on a row
      // this statement inserted and is non-zero on one it updated — the only way
      // to answer 201 versus 200 without a second query, and without a race
      // between the two.
      const [row] = await tx.$queryRaw<(InviteRow & { inserted: boolean })[]>`
        INSERT INTO invites (id, tenant_id, email, role, token_hash, invited_by_user_id, expires_at)
        VALUES (
          ${uuidV7()}::uuid,
          ${tenantId}::uuid,
          ${input.email}::citext,
          ${input.role}::user_role,
          ${hashAuthToken(token)},
          ${principal.userId}::uuid,
          ${expiresAt}
        )
        ON CONFLICT (tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL
        DO UPDATE SET token_hash         = EXCLUDED.token_hash,
                      expires_at         = EXCLUDED.expires_at,
                      role               = EXCLUDED.role,
                      invited_by_user_id = EXCLUDED.invited_by_user_id
        RETURNING id,
                  email::text AS email,
                  role::text  AS role,
                  invited_by_user_id,
                  expires_at,
                  accepted_at,
                  revoked_at,
                  created_at,
                  (xmax = 0)  AS inserted
      `;

      if (row === undefined) {
        // `ON CONFLICT … DO UPDATE` always returns the row it touched, so this
        // is unreachable — and if the statement ever stops returning one, a
        // clear throw beats a `TypeError` two frames later.
        throw new Error('The invite upsert returned no row.');
      }

      await this.replacePendingTeams(tx, tenantId, row.id, input.teamIds);

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.inviteCreated,
        targetType: 'invite',
        targetId: row.id,
        // The token is absent on purpose: `audit_logs` is read by support and
        // exported for compliance review, and it is not a place to keep
        // credentials.
        metadata: { email: input.email, role: input.role, teamIds: input.teamIds },
      });

      return { invite: fromRawInvite(row), inserted: row.inserted, teamIds: input.teamIds };
    });

    await this.deliver(created.invite, token, principal.displayName);

    return {
      invite: toInviteResponse(created.invite, created.teamIds),
      created: created.inserted,
    };
  }

  /**
   * The outstanding invitations, so an admin can see who has not accepted.
   *
   * Keyset paginated on `id`, which is a UUIDv7 and therefore already in
   * creation order — one column does the job of `(created_at, id)` and the
   * primary key serves the scan.
   */
  async list(query: InviteListQuery): Promise<CursorPage<InviteResponse>> {
    const rows = await this.prisma.invite.findMany({
      where: {
        ...statusFilter(query.status),
        ...(query.cursor === undefined ? {} : { id: { lt: query.cursor } }),
      },
      select: INVITE_PROJECTION,
      orderBy: { id: 'desc' },
      // One more than the page, so "is there another page" costs a row rather
      // than a `count(*)` over the whole filtered set on every request.
      take: query.limit + 1,
    });

    const items = rows.slice(0, query.limit);

    return {
      items: items.map((row) =>
        toInviteResponse(
          row,
          row.teams.map((team) => team.teamId),
        ),
      ),
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Issues a fresh token for a pending invitation and mails it again.
   *
   * The old link stops working the moment this succeeds, which is the useful
   * half: an invite mailed to the wrong address is undone by resending to the
   * right one. Role and teams are untouched — changing those is
   * `POST /users/invites`, and keeping them separate is what lets the audit trail
   * say which of the two an admin actually did.
   */
  async resend(inviteId: string): Promise<InviteResponse> {
    const token = generateAuthToken();
    const expiresAt = new Date(Date.now() + AUTH_POLICY.inviteTtlMs);

    const invite = await this.prisma.$tenantTransaction(async (tx) => {
      const pending = await this.requirePendingInvite(tx, inviteId);

      const row = await tx.invite.update({
        where: { id: pending.id },
        data: { tokenHash: hashAuthToken(token), expiresAt },
        select: INVITE_PROJECTION,
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.inviteResent,
        targetType: 'invite',
        targetId: row.id,
        metadata: { email: row.email },
      });

      return row;
    });

    await this.deliver(invite, token, this.tenantContext.requirePrincipal().displayName);

    return toInviteResponse(
      invite,
      invite.teams.map((team) => team.teamId),
    );
  }

  /**
   * Withdraws a pending invitation. The link stops working immediately.
   *
   * Idempotent: withdrawing an already-withdrawn invite is a no-op rather than a
   * second audit row claiming it happened twice.
   *
   * The invitee's `invited` user row is deliberately left alone. Revoking is
   * "this link is cancelled"; removing the account is `DELETE /api/v1/users/{id}`,
   * which is admin-only and audited separately. Folding the two together would
   * let a caller holding `user:invite` remove an account through the side door.
   */
  async revoke(inviteId: string): Promise<void> {
    await this.prisma.$tenantTransaction(async (tx) => {
      const invite = await tx.invite.findUnique({
        where: { id: inviteId },
        select: { id: true, email: true, acceptedAt: true, revokedAt: true },
      });

      if (invite === null) {
        // Absent, or in another tenant — RLS makes the two indistinguishable,
        // which is the intent: a 403 here would confirm the id exists somewhere.
        throw new InviteNotFoundError(inviteId);
      }

      if (invite.revokedAt !== null) {
        return;
      }

      if (invite.acceptedAt !== null) {
        throw new InviteNotPendingError('accepted');
      }

      await tx.invite.update({
        where: { id: invite.id },
        data: { revokedAt: new Date() },
        select: { id: true },
      });

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.inviteRevoked,
        targetType: 'invite',
        targetId: invite.id,
        metadata: { email: invite.email },
      });
    });
  }

  /**
   * What the accept screen renders before anyone types a password.
   *
   * Deliberately minimal — enough for "Alice invited you to join Acme Support",
   * and nothing more. Anyone holding a random string can call this, so it must
   * not become a tenant-enumeration oracle: an unknown, expired, revoked or
   * already-accepted token answers `token_invalid` and describes nothing.
   */
  async preview(token: string): Promise<InvitePreviewResponse> {
    const invite = await this.findByToken(this.prisma, hashAuthToken(token));

    assertUsable(invite);

    return {
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expires_at.toISOString(),
      tenantName: invite.tenant_name,
      invitedByName: invite.invited_by_name,
    };
  }

  /**
   * Redeems an invitation: sets the password, activates the account inside the
   * inviting tenant with the role the admin assigned, and signs the invitee in.
   *
   * The order is load-bearing. The token is checked **before** the password is
   * hashed, so an unauthenticated caller cannot spend 19 MiB and two argon2
   * passes of this process's memory per request by posting rubbish; and the
   * password is hashed **before** the transaction opens, so a memory-hard hash
   * never runs with a database transaction held open. The conditional `UPDATE`
   * inside the transaction is then the authoritative single-use check — the
   * pre-flight read is a courtesy, not the gate.
   */
  async accept(input: InviteAcceptInput, origin: SessionOrigin): Promise<AcceptedInvite> {
    const tenantId = this.tenantContext.requireTenantId();
    const tokenHash = hashAuthToken(input.token);

    assertUsable(await this.findByToken(this.prisma, tokenHash));

    const passwordHash = await this.passwords.hash(input.password);

    const accepted = await this.prisma.$tenantTransaction(async (tx) => {
      const [invite] = await tx.$queryRaw<RedeemedInvite[]>`
        UPDATE invites
        SET accepted_at = now()
        WHERE token_hash  = ${tokenHash}
          AND accepted_at IS NULL
          AND revoked_at  IS NULL
          AND expires_at  > now()
        RETURNING id, email::text AS email, role::text AS role
      `;

      if (invite === undefined) {
        // Lost the race with another use of the same link, or it lapsed between
        // the read above and here. Re-read to say which.
        assertUsable(await this.findByToken(tx, tokenHash));
        throw new InviteTokenInvalidError('consumed');
      }

      const user = await this.activateAccount(
        tx,
        tenantId,
        invite,
        input.displayName,
        passwordHash,
      );
      const teamIds = await this.joinPendingTeams(tx, tenantId, invite.id, user.id);

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.inviteAccepted,
        targetType: 'user',
        targetId: user.id,
        metadata: { inviteId: invite.id, role: invite.role, teamIds },
      });

      const issued = await this.sessions.issue(tx, {
        tenantId,
        userId: user.id,
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      const principal: SessionPrincipal = {
        userId: user.id,
        tenantId,
        email: user.email,
        displayName: user.name,
        role: invite.role,
        // Materialised from the role through the contract's own table — never a
        // literal, so a session cannot disagree with what the matrix grants.
        permissions: [...permissionsForRole(invite.role)],
        teamIds,
        sessionId: issued.sessionId,
        expiresAt: issued.expiresAt.toISOString(),
      };

      return { issued, principal };
    });

    // After the commit, for the same reason login publishes there: a cached
    // principal for a transaction that rolled back would be a live credential
    // for a session that does not exist.
    await this.sessions.publish(accepted.issued, accepted.principal);

    // The Redis half of the clean start the columns above give a reactivated
    // account. The per-email lockout counts every address that is typed at
    // login, including one that has no account yet, so an invitee whose address
    // somebody had been guessing at would otherwise accept and then be unable
    // to sign in again for the rest of the window.
    await this.loginThrottle.clearEmailFailures(
      accepted.principal.tenantId,
      accepted.principal.email,
    );

    this.logger.log(`Invite accepted; activated user ${accepted.principal.userId}`);

    return { principal: accepted.principal, sessionToken: accepted.issued.token };
  }

  /**
   * Holds the address in `users` so that "one account per email per tenant" is a
   * unique constraint rather than a check somebody has to remember.
   *
   * An address that already has a usable account — `active` or `suspended` — is
   * a `conflict`: the admin wants to reactivate or re-permission that person,
   * not create a second one. A `removed` account is invitable again, and
   * acceptance reactivates *that* row rather than creating a rival, which keeps
   * their history attributable (ADR 0005, "Invite create").
   */
  private async reserveAccount(
    tx: Prisma.TransactionClient,
    tenantId: string,
    email: string,
    role: TenantRole,
  ): Promise<void> {
    const existing = await tx.user.findFirst({
      where: { email },
      select: { id: true, status: true },
    });

    if (existing === null) {
      await tx.user.create({
        data: {
          tenantId,
          email,
          // The invitee sets their real name when they accept. A placeholder
          // rather than a nullable column: `name` is NOT NULL and every list
          // rendering it would otherwise need a fallback.
          name: email.split('@')[0] ?? email,
          role,
          status: 'invited',
        },
        select: { id: true },
      });
      return;
    }

    if (existing.status === 'active' || existing.status === 'suspended') {
      throw new EmailAlreadyRegisteredError(email);
    }

    await tx.user.update({
      where: { id: existing.id },
      data: { role, status: 'invited' },
      select: { id: true },
    });
  }

  /** The teams the invitee joins on acceptance — replaced wholesale, never merged. */
  private async replacePendingTeams(
    tx: Prisma.TransactionClient,
    tenantId: string,
    inviteId: string,
    teamIds: readonly string[],
  ): Promise<void> {
    await tx.inviteTeam.deleteMany({ where: { inviteId } });

    if (teamIds.length > 0) {
      await tx.inviteTeam.createMany({
        data: [...new Set(teamIds)].map((teamId) => ({ tenantId, inviteId, teamId })),
      });
    }
  }

  /** Turns the reserved `invited` row into a real account. */
  private async activateAccount(
    tx: Prisma.TransactionClient,
    tenantId: string,
    invite: RedeemedInvite,
    displayName: string,
    passwordHash: string,
  ): Promise<{ id: string; email: string; name: string }> {
    const existing = await tx.user.findFirst({
      where: { email: invite.email },
      select: { id: true, status: true },
    });

    if (existing !== null && (existing.status === 'active' || existing.status === 'suspended')) {
      // The address gained an account between the invite and this call. Throwing
      // rolls the acceptance back, so the link is not silently spent.
      throw new EmailAlreadyRegisteredError(invite.email);
    }

    const data = {
      name: displayName,
      passwordHash,
      // From the invite, never from the request body: this is the whole point of
      // the role living on the row the admin wrote.
      role: invite.role,
      status: 'active',
      // A reactivated `removed` account starts clean rather than inheriting a
      // lockout from whatever happened before it was removed.
      failedLoginAttempts: 0,
      lastFailedLoginAt: null,
      lockedUntil: null,
    } as const;

    return existing === null
      ? tx.user.create({
          data: { tenantId, email: invite.email, ...data },
          select: { id: true, email: true, name: true },
        })
      : tx.user.update({
          where: { id: existing.id },
          data,
          select: { id: true, email: true, name: true },
        });
  }

  /** Materialises `invite_teams` as real memberships, and reports what they are. */
  private async joinPendingTeams(
    tx: Prisma.TransactionClient,
    tenantId: string,
    inviteId: string,
    userId: string,
  ): Promise<string[]> {
    const pending = await tx.inviteTeam.findMany({
      where: { inviteId },
      select: { teamId: true },
    });
    const teamIds = pending.map((team) => team.teamId);

    if (teamIds.length > 0) {
      await tx.teamMember.createMany({
        data: teamIds.map((teamId) => ({ tenantId, teamId, userId })),
        // A reactivated account may still hold a membership the invite also
        // names; the row is the same either way.
        skipDuplicates: true,
      });
    }

    return teamIds;
  }

  /** The row the admin is acting on, refused unless the link is still live. */
  private async requirePendingInvite(
    tx: Prisma.TransactionClient,
    inviteId: string,
  ): Promise<{ id: string }> {
    const invite = await tx.invite.findUnique({
      where: { id: inviteId },
      select: { id: true, acceptedAt: true, revokedAt: true },
    });

    if (invite === null) {
      throw new InviteNotFoundError(inviteId);
    }

    if (invite.acceptedAt !== null) {
      throw new InviteNotPendingError('accepted');
    }

    if (invite.revokedAt !== null) {
      throw new InviteNotPendingError('revoked');
    }

    return { id: invite.id };
  }

  /**
   * One statement, and one clock. Every expiry decision in this file compares
   * against the **database's** `now()` rather than this node's, so skew between
   * API instances cannot resurrect a lapsed token or kill a live one.
   */
  private async findByToken(
    client: Pick<Prisma.TransactionClient, '$queryRaw'>,
    tokenHash: string,
  ): Promise<InviteLookupRow | undefined> {
    const [row] = await client.$queryRaw<InviteLookupRow[]>`
      SELECT i.email::text AS email,
             i.role::text  AS role,
             i.expires_at,
             i.accepted_at,
             i.revoked_at,
             t.name        AS tenant_name,
             u.name        AS invited_by_name,
             now()         AS server_now
      FROM invites i
      JOIN tenants t ON t.id = i.tenant_id
      LEFT JOIN users u ON u.tenant_id = i.tenant_id AND u.id = i.invited_by_user_id
      WHERE i.token_hash = ${tokenHash}
    `;

    return row;
  }

  /**
   * Sends the link, after the transaction has committed.
   *
   * Outside the transaction because a memory-hard hash and a mail round trip are
   * both things that must never be held open across a database transaction. The
   * consequence is that a mailer failure leaves a real invitation nobody was
   * told about — which is the documented failure mode (ADR 0005: "invites and
   * resets are created but never delivered") and is recoverable with a resend.
   * Failing the request instead would claim nothing happened, which would be a
   * lie about a committed row.
   */
  private async deliver(
    invite: { id: string; email: string; expiresAt: Date },
    token: string,
    inviterName: string,
  ): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();

    try {
      await this.mailer.send({
        to: invite.email,
        template: 'invite',
        tenantId,
        // A path plus a token rather than a rendered URL: the host has to be the
        // tenant's primary domain resolved from the control plane, never the
        // request `Host`, so assembling the link is the adapter's job.
        data: {
          linkPath: INVITE_LINK_PATH,
          token,
          inviterName,
          expiresAt: invite.expiresAt.toISOString(),
        },
      });
    } catch (error) {
      // Never the token, and never the link that carries it.
      this.logger.error(
        `Invite ${invite.id} was created but its email could not be sent. It can be resent.`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}

/** The columns every `InviteResponse` is built from. `token_hash` is not among them. */
const INVITE_PROJECTION = {
  id: true,
  email: true,
  role: true,
  invitedByUserId: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  teams: { select: { teamId: true } },
} as const satisfies Prisma.InviteSelect;

/**
 * What every invite response is built from, whatever read produced it.
 *
 * The upsert has to be raw SQL — Prisma cannot express `ON CONFLICT` against a
 * *partial* unique index — so its result arrives in the database's snake_case
 * while the client's arrives in Prisma's camelCase. Normalising to one shape at
 * the boundary keeps a single mapper instead of one per read.
 */
interface InviteRecord {
  id: string;
  email: string;
  role: TenantRole;
  invitedByUserId: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

interface InviteRow {
  id: string;
  email: string;
  role: TenantRole;
  invited_by_user_id: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

function fromRawInvite(row: InviteRow): InviteRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedByUserId: row.invited_by_user_id,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

interface RedeemedInvite {
  id: string;
  email: string;
  role: TenantRole;
}

interface InviteLookupRow {
  email: string;
  role: TenantRole;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  tenant_name: string;
  invited_by_name: string | null;
  server_now: Date;
}

/**
 * Turns a row that is not a live invitation into the one error the accept screen
 * knows how to act on, and narrows the type for everything after it.
 *
 * `reason` is safe to disclose: the token is 256 bits of uniform entropy, so
 * telling whoever presented it that theirs has expired reveals nothing they
 * could not have learned by trying it. What it buys is "ask your admin to
 * resend" instead of a dead end.
 */
function assertUsable(invite: InviteLookupRow | undefined): asserts invite is InviteLookupRow {
  const reason = rejectionReason(invite);

  if (reason !== null) {
    throw new InviteTokenInvalidError(reason);
  }
}

function rejectionReason(invite: InviteLookupRow | undefined): TokenRejectionReason | null {
  if (invite === undefined) {
    // Unknown here also covers "belongs to another tenant": the read runs under
    // RLS, so another tenant's invite is not absent-looking, it is absent.
    return 'unknown';
  }

  if (invite.revoked_at !== null) {
    return 'revoked';
  }

  if (invite.accepted_at !== null) {
    return 'consumed';
  }

  return invite.expires_at.getTime() <= invite.server_now.getTime() ? 'expired' : null;
}

/**
 * `pending` is the set whose link still works: un-accepted, un-revoked and in
 * date. `expired` is therefore its own answer rather than a subset of pending,
 * because those are the invites worth resending.
 *
 * This is the one expiry comparison in the file that uses the node's clock
 * rather than the database's, and it can be: it decides how a row is *labelled*
 * in a list, not whether a token is honoured. Skew of a few milliseconds around
 * a seven-day boundary changes which page an invitation appears on and nothing
 * else — redemption is checked against `now()` inside the statement that
 * redeems it.
 */
function statusFilter(status: InviteListQuery['status']): Prisma.InviteWhereInput {
  switch (status) {
    case undefined:
      return {};
    case 'accepted':
      return { acceptedAt: { not: null } };
    case 'revoked':
      return { revokedAt: { not: null } };
    case 'pending':
      return { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } };
    case 'expired':
      return { acceptedAt: null, revokedAt: null, expiresAt: { lte: new Date() } };
  }
}

function toInviteResponse(invite: InviteRecord, teamIds: readonly string[]): InviteResponse {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    // Nullable, because the column is: a platform-issued bootstrap invite for a
    // freshly provisioned tenant has no inviting user to name.
    invitedByUserId: invite.invitedByUserId,
    teamIds: [...teamIds],
    expiresAt: invite.expiresAt.toISOString(),
    acceptedAt: invite.acceptedAt?.toISOString() ?? null,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
  };
}
