import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUTH_POLICY,
  TENANT_ROLES,
  permissionsForRole,
  type TenantRole,
} from '@whatsappcrm/contracts';
import type { Request } from 'express';
import { generateAuthToken, hashAuthToken } from '../identity/auth-tokens';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  ANONYMOUS,
  resolved,
  type PrincipalResolution,
  type PrincipalSource,
} from './principal.source';

/**
 * ⚠️ **INTERIM STUB — DELETE THIS FILE WHEN TAR-35 LANDS.**
 *
 * TAR-35 owns sessions, and it has not shipped, so there is no session to read a
 * role from. TAR-22 still has to build and prove the permission matrix now. The
 * answer (TAR-79, "interim role resolution") is to **stub the source of the
 * principal, never the guard**: `PermissionGuard`, the visibility predicate and
 * every invariant below run identically before and after TAR-35, so what QA
 * tests today is the real enforcement path with a different supplier.
 *
 * Bound only when `AUTH_STUB_ENABLED=true`, which the environment schema refuses
 * to accept under `NODE_ENV=production` — a misconfigured deploy fails to boot
 * rather than serving one stubbed request.
 *
 * Three properties keep it honest, and they are the ones to check at review:
 *
 *   * **It grants nothing.** It produces a principal; `PermissionGuard` still
 *     decides what that principal may do, and RLS still decides what it can see.
 *   * **`tenantId` is never a constant.** It is the tenant `HostTenantGuard`
 *     resolved from the request host, so every query still runs under the GUC
 *     that TAR-48's policies read. A hardcoded tenant id would let these tests
 *     pass with tenant isolation never exercised — the exact failure mode
 *     ADR 0002 warns about.
 *   * **`userId` and `teamIds` are never constants either.** They come from a
 *     real `users` row holding that role in that tenant, so a scoped list query
 *     is scoped to somebody who actually exists.
 *
 * The role itself comes from the same `wac_role_stub` cookie the console sets
 * (TAR-82), so one switch in the UI drives both halves and they cannot disagree.
 * `x-dev-role` overrides it for curl and integration tests, and wins when both
 * are present.
 *
 * ## Why it writes a `sessions` row (TAR-576)
 *
 * `sessionId` used to be a literal naming a row that did not exist, and one
 * caller does not take the principal's word for it: the Socket.IO handshake
 * spends its ticket and then re-reads the session behind it through
 * `SessionService.resolveBySessionId` — deliberately, because that re-read is
 * what lets "log this person out everywhere" reach an already-open socket.
 * Against zero rows it answered `null`, so **every** WebSocket upgrade was
 * refused under the stub and no realtime feature could be verified in a browser
 * locally.
 *
 * Teaching the handshake to recognise a magic id would have been the smaller
 * diff and is the wrong one: it puts an `if (stub)` inside the enforcement path,
 * which is exactly what "stub the source of the principal, never the guard"
 * exists to prevent. So the stub supplies the session too, and the handshake
 * keeps running its real ticket spend, its real session read, its real liveness
 * predicates and its real RLS.
 */

/** Deliberately not `wac_session`: the two must never be confused. */
export const ROLE_STUB_COOKIE_NAME = 'wac_role_stub';
export const ROLE_STUB_HEADER = 'x-dev-role';

const DEFAULT_STUB_ROLE: TenantRole = 'admin';

/**
 * Salts the session id derived below, so the value is stable across restarts and
 * reseeds without being something another table could collide with.
 */
const STUB_SESSION_NAMESPACE = 'whatsappcrm:interim-role-stub:session';

@Injectable()
export class StubPrincipalSource implements PrincipalSource {
  private readonly logger = new Logger(StubPrincipalSource.name);

  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  async resolve(request: Request, tenantId: string): Promise<PrincipalResolution> {
    const role = parseStubRole(stubRoleFrom(request));

    // Reads through `TenantPrisma`, so the lookup itself is bounded by the
    // tenant in scope — the stub cannot reach into another tenant to find
    // somebody with the role it was asked for.
    const user = await this.prisma.user.findFirst({
      where: { role, status: 'active' },
      select: {
        id: true,
        email: true,
        name: true,
        teamMemberships: { select: { teamId: true } },
      },
      // Stable across calls, so a test that seeds two admins keeps getting the
      // same one rather than whichever the planner returned first.
      orderBy: { id: 'asc' },
    });

    if (user === null) {
      this.logger.warn(
        `Interim role stub found no active ${role} in tenant ${tenantId}. ` +
          'Seed one, or the request is refused as unauthenticated.',
      );
      return ANONYMOUS;
    }

    const sessionId = stubSessionId(tenantId, user.id);
    const expiresAt = await this.holdSessionOpen(sessionId, tenantId, user.id);

    // Never `replayed`: the stub reads through `TenantPrisma`, so the only
    // tenant it can find anybody in is the one already in scope.
    return resolved({
      userId: user.id,
      tenantId,
      email: user.email,
      displayName: user.name,
      role,
      // Materialised from the role through the contract's own table — never a
      // literal array, here or anywhere, so the stub cannot disagree with what
      // the matrix grants.
      permissions: [...permissionsForRole(role)],
      teamIds: user.teamMemberships.map((membership) => membership.teamId),
      sessionId,
      // The row's own deadline rather than a literal, so the principal and the
      // row the realtime handshake re-reads cannot state two different things.
      expiresAt: expiresAt.toISOString(),
    });
  }

  /**
   * Makes `sessionId` a live row for this user, and answers its idle deadline.
   *
   * There is no login to write one, so every request writes it — an upsert on
   * the primary key, which is why two requests racing settle rather than
   * collide. The cost is one extra statement per authenticated request, paid
   * only where the stub is bound, which the environment schema refuses to accept
   * under `NODE_ENV=production`.
   *
   * Three details are deliberate:
   *
   *   * **`token_hash` is written once and is unguessable.** The digest of a
   *     token generated here and immediately forgotten — no plaintext exists, in
   *     this process or anywhere else, so the row cannot be presented as a
   *     session cookie by anybody who reads this file. `DO UPDATE` leaves the
   *     column alone, so that stays true for the life of the row, including
   *     after `AUTH_STUB_ENABLED` is turned back off and the rows outlive the
   *     stub that wrote them.
   *   * **Both deadlines come from the database's `now()`**, as everything in
   *     `SessionService` does, so a stub session and a real one are read by the
   *     same predicates against the same clock.
   *   * **A dead session is replaced, and a live one is never extended past its
   *     cap.** Under the stub there is no login to perform, so a row that has
   *     been revoked — `TeamsService` and `UsersService` both reach
   *     `revokeAllForUsers` through `SessionRevocationService` — or that has
   *     reached `absolute_expires_at` would otherwise leave local realtime dead
   *     until somebody reseeded, which is TAR-576 again on a timer. Starting a
   *     new session on the row is what signing back in would do. What use does
   *     **not** do is push the cap: while `absolute_expires_at` is still in the
   *     future it is carried over untouched, so the column keeps the meaning
   *     `schema.prisma` gives it — `created_at + sessionAbsoluteMs`, the bound
   *     the sliding `expires_at` may not cross — and `created_at` is restamped
   *     with it so the two cannot disagree. The revocation path itself is
   *     proved against real sessions by `session-lifecycle.int-spec.ts`, not by
   *     this; what is proved here is that the stub recovers from it.
   */
  private async holdSessionOpen(
    sessionId: string,
    tenantId: string,
    userId: string,
  ): Promise<Date> {
    const [row] = await this.prisma.$queryRaw<{ expires_at: Date }[]>`
      INSERT INTO sessions (
        id, tenant_id, user_id, token_hash,
        expires_at, absolute_expires_at, last_seen_at, created_at
      )
      VALUES (
        ${sessionId}::uuid,
        ${tenantId}::uuid,
        ${userId}::uuid,
        ${hashAuthToken(generateAuthToken())},
        now() + make_interval(secs => ${AUTH_POLICY.sessionIdleMs / 1_000}::double precision),
        now() + make_interval(secs => ${AUTH_POLICY.sessionAbsoluteMs / 1_000}::double precision),
        now(),
        now()
      )
      ON CONFLICT (id) DO UPDATE
         SET expires_at          = EXCLUDED.expires_at,
             last_seen_at        = now(),
             revoked_at          = NULL,
             revoked_reason      = NULL,
             -- Carried over while the cap is still ahead, restarted once it is
             -- not: a request extends the idle window and never the cap.
             created_at          = CASE
                                     WHEN sessions.absolute_expires_at > now()
                                     THEN sessions.created_at
                                     ELSE EXCLUDED.created_at
                                   END,
             absolute_expires_at = CASE
                                     WHEN sessions.absolute_expires_at > now()
                                     THEN sessions.absolute_expires_at
                                     ELSE EXCLUDED.absolute_expires_at
                                   END
      RETURNING expires_at
    `;

    if (row === undefined) {
      // An upsert that returns nothing means the statement did not run — the
      // same reading `SessionService.issue` gives it.
      throw new Error(`Interim role stub could not hold session ${sessionId} open.`);
    }

    return row.expires_at;
  }
}

/**
 * The session id a stub principal carries: derived from the tenant and the user,
 * never a constant.
 *
 * A single literal is what TAR-576 broke on the moment the id had to name a real
 * row. `sessions.id` is a primary key, so one literal is one row for the whole
 * database — and the seed alone ships two tenants, each with an admin, a
 * supervisor and an agent that the role switch moves between. Whichever of those
 * six wrote the row first would own it, and every other one would present a
 * ticket whose session resolves to somebody else, refused by the handshake's own
 * tenant-and-user comparison.
 *
 * Derived rather than random for the reason the literal existed: the id shows up
 * in `GET /auth/sessions` as the current device, and a fresh one per request
 * would leave a trail of rows behind every page load.
 *
 * RFC 9562 §5.8 version 8 — "custom", which is what this is. Not v7: the layout
 * carries no timestamp, and claiming a version by setting its nibble is how an
 * id ends up sorted by a prefix that means nothing.
 */
function stubSessionId(tenantId: string, userId: string): string {
  const digest = createHash('sha256')
    .update(`${STUB_SESSION_NAMESPACE}:${tenantId}:${userId}`, 'utf8')
    .digest();

  // Version in the high nibble of byte 6, RFC 9562 variant in the top two bits
  // of byte 8. Written through the accessors rather than by index because
  // `noUncheckedIndexedAccess` types a byte read as `number | undefined`.
  digest.writeUInt8((digest.readUInt8(6) & 0x0f) | 0x80, 6);
  digest.writeUInt8((digest.readUInt8(8) & 0x3f) | 0x80, 8);

  const hex = digest.subarray(0, 16).toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** The header wins over the cookie, so a curl call is not fighting a browser. */
function stubRoleFrom(request: Request): string | undefined {
  const header = request.header(ROLE_STUB_HEADER);

  return header !== undefined && header !== ''
    ? header
    : cookieValue(request, ROLE_STUB_COOKIE_NAME);
}

export function parseStubRole(value: string | undefined): TenantRole {
  return TENANT_ROLES.find((role) => role === value) ?? DEFAULT_STUB_ROLE;
}

/**
 * Reads one cookie off the raw header rather than adding `cookie-parser`.
 *
 * The API has no other need for cookies until TAR-35, and that story will bring
 * the middleware it wants along with the session it parses. A dependency added
 * for a file marked for deletion is a dependency nobody removes.
 */
function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;

  if (header === undefined) {
    return undefined;
  }

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');

    if (separator === -1) {
      continue;
    }

    if (pair.slice(0, separator).trim() === name) {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }
  }

  return undefined;
}
