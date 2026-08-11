import { Inject, Injectable, Logger } from '@nestjs/common';
import { TENANT_ROLES, permissionsForRole, type TenantRole } from '@whatsappcrm/contracts';
import type { Request } from 'express';
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
 */

/** Deliberately not `wac_session`: the two must never be confused. */
export const ROLE_STUB_COOKIE_NAME = 'wac_role_stub';
export const ROLE_STUB_HEADER = 'x-dev-role';

const DEFAULT_STUB_ROLE: TenantRole = 'admin';

/** Literals: a fresh value per request would make responses non-deterministic. */
const STUB_SESSION_ID = '0192f0ff-0000-7000-8000-0000000000ff';
const STUB_SESSION_EXPIRES_AT = '2026-12-31T23:59:59.000Z';

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
      sessionId: STUB_SESSION_ID,
      expiresAt: STUB_SESSION_EXPIRES_AT,
    });
  }
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
