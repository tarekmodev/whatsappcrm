import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import type { Request } from 'express';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import {
  ROLE_STUB_COOKIE_NAME,
  ROLE_STUB_HEADER,
  StubPrincipalSource,
  parseStubRole,
} from './stub-principal.source';

/**
 * ⚠️ Tests for the interim stub — delete alongside it when TAR-35 lands.
 *
 * What is asserted is not that the stub is correct in any deep sense but the
 * four properties that stop it becoming a security hole or a dead end: it
 * materialises permissions through the contract, it never invents a tenant, it
 * never invents a user, and — since TAR-576 — the session it names is a row it
 * wrote for that user rather than a literal nothing can resolve.
 *
 * The session half is asserted here at the statement, and end to end through a
 * real socket handshake in `realtime-stub-handshake.int-spec.ts`.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000b1';
const OTHER_TENANT = '0192f0ff-0000-7000-8000-0000000000b2';
const TEAM = '0192f0ff-0000-7000-8000-00000000b001';

/** What the row the upsert wrote would say, played back to the caller. */
const ROW_EXPIRES_AT = new Date('2026-09-01T10:00:00.000Z');

interface Upsert {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function requestWith(headers: Record<string, string | undefined>): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    headers: { cookie: headers.cookie },
  } as unknown as Request;
}

/**
 * The stub, over a client that answers with `user` and records the session
 * upsert instead of running it.
 *
 * The upserts are exposed rather than swallowed because two of the assertions
 * below are about the statement itself — which id it names, and whose row it
 * writes.
 */
function sourceFinding(user: unknown): {
  source: StubPrincipalSource;
  upserts: Upsert[];
} {
  const upserts: Upsert[] = [];
  const prisma = {
    user: { findFirst: () => Promise.resolve(user) },
    $queryRaw: (sql: TemplateStringsArray, ...values: unknown[]) => {
      upserts.push({ sql: sql.join('?'), values });

      return Promise.resolve([{ expires_at: ROW_EXPIRES_AT }]);
    },
  } as unknown as TenantPrisma;

  return { source: new StubPrincipalSource(prisma), upserts };
}

/**
 * The principal the stub produced, or `null` when it produced none.
 *
 * `PrincipalSource.resolve` answers a `PrincipalResolution` since TAR-58, so the
 * outcome is unwrapped here rather than in every assertion below. The stub can
 * never answer `replayed` — it reads through `TenantPrisma`, so the only tenant
 * it can find anybody in is the one already in scope.
 */
async function principalFrom(
  source: StubPrincipalSource,
  request: Request,
  tenantId: string = TENANT,
): Promise<SessionPrincipal | null> {
  const resolution = await source.resolve(request, tenantId);

  return resolution.outcome === 'resolved' ? resolution.principal : null;
}

const SEEDED = {
  id: '0192f0ff-0000-7000-8000-00000000a001',
  email: 'supervisor@example.invalid',
  name: 'Sam Supervisor',
  teamMemberships: [{ teamId: TEAM }],
};

describe('the interim role stub', () => {
  it('falls back to admin for an absent or unrecognised role', () => {
    expect(parseStubRole(undefined)).toBe('admin');
    expect(parseStubRole('owner')).toBe('admin');
    expect(parseStubRole('')).toBe('admin');
  });

  it('reads the role from the same cookie the console sets', async () => {
    const principal = await principalFrom(
      sourceFinding(SEEDED).source,
      requestWith({ cookie: `theme=dark; ${ROLE_STUB_COOKIE_NAME}=supervisor; other=x` }),
    );

    expect(principal?.role).toBe('supervisor');
  });

  it('lets the header win over the cookie, for curl and integration tests', async () => {
    const principal = await principalFrom(
      sourceFinding(SEEDED).source,
      requestWith({
        [ROLE_STUB_HEADER]: 'agent',
        cookie: `${ROLE_STUB_COOKIE_NAME}=admin`,
      }),
    );

    expect(principal?.role).toBe('agent');
  });

  // The property that keeps the stub from making TAR-81's tests meaningless: a
  // hardcoded tenant id would let every one of them pass with RLS never
  // exercised, which is the failure mode ADR 0002 warns about.
  it('takes the tenant from the caller, never from itself', async () => {
    const principal = await principalFrom(sourceFinding(SEEDED).source, requestWith({}));

    expect(principal?.tenantId).toBe(TENANT);
  });

  it('takes the user and their teams from a real seeded row', async () => {
    const principal = await principalFrom(sourceFinding(SEEDED).source, requestWith({}));

    expect(principal?.userId).toBe(SEEDED.id);
    expect(principal?.email).toBe(SEEDED.email);
    expect(principal?.teamIds).toEqual([TEAM]);
  });

  it('materialises permissions through the contract rather than listing them', async () => {
    for (const role of ['agent', 'supervisor', 'admin'] as const) {
      const principal = await principalFrom(
        sourceFinding(SEEDED).source,
        requestWith({ [ROLE_STUB_HEADER]: role }),
      );

      expect(principal?.permissions).toEqual([...permissionsForRole(role)]);
    }
  });

  it('authenticates nobody when the tenant holds no active user with that role', async () => {
    // Refused as unauthenticated rather than fabricated — the stub supplies a
    // principal, it does not invent one.
    await expect(principalFrom(sourceFinding(null).source, requestWith({}))).resolves.toBeNull();
  });

  // TAR-576. The stub named a session that had no row, so every realtime
  // handshake — which re-reads the session behind the ticket — was refused.
  describe('the session it names', () => {
    it('is a row it upserts for that user, in that tenant', async () => {
      const { source, upserts } = sourceFinding(SEEDED);
      const principal = await principalFrom(source, requestWith({}));
      const [upsert] = upserts;

      expect(upsert?.sql).toContain('INSERT INTO sessions');
      expect(upsert?.sql).toContain('ON CONFLICT (id) DO UPDATE');
      // Bound parameters, in the order the statement lists them: the id, the
      // tenant the caller resolved, the user actually found, then the digest.
      expect(upsert?.values.slice(0, 3)).toEqual([principal?.sessionId, TENANT, SEEDED.id]);
    });

    it('never writes a token anybody could present as a session cookie', async () => {
      const { source, upserts } = sourceFinding(SEEDED);

      await principalFrom(source, requestWith({}));
      await principalFrom(source, requestWith({}));

      // A SHA-256 digest of a token generated here and immediately forgotten:
      // no plaintext exists to replay, and it is derived from nothing a reader
      // of this file could reconstruct — which is why it differs per call even
      // though the id does not.
      expect(upserts[0]?.values[3]).toMatch(/^[0-9a-f]{64}$/);
      expect(upserts[0]?.values[3]).not.toBe(upserts[1]?.values[3]);
    });

    it('is stable for one user, so a page load does not leave a trail of rows', async () => {
      const { source } = sourceFinding(SEEDED);

      const first = await principalFrom(source, requestWith({}));
      const second = await principalFrom(source, requestWith({}));

      expect(first?.sessionId).toBe(second?.sessionId);
    });

    // The id is the primary key of a table shared by every tenant, so a literal
    // would be one row for the whole database — and five of the seed's six
    // stub users would present a ticket resolving to somebody else.
    it('differs per tenant and per user', async () => {
      const { source } = sourceFinding(SEEDED);
      const here = await principalFrom(source, requestWith({}), TENANT);
      const there = await principalFrom(source, requestWith({}), OTHER_TENANT);

      const other = sourceFinding({ ...SEEDED, id: '0192f0ff-0000-7000-8000-00000000a002' });
      const somebodyElse = await principalFrom(other.source, requestWith({}));

      expect(here?.sessionId).not.toBe(there?.sessionId);
      expect(here?.sessionId).not.toBe(somebodyElse?.sessionId);
    });

    it('reports the deadline the row carries, not a literal', async () => {
      const principal = await principalFrom(sourceFinding(SEEDED).source, requestWith({}));

      expect(principal?.expiresAt).toBe(ROW_EXPIRES_AT.toISOString());
    });
  });
});
