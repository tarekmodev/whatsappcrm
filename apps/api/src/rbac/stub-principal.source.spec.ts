import { permissionsForRole } from '@whatsappcrm/contracts';
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
 * three properties that stop it becoming a security hole: it materialises
 * permissions through the contract, it never invents a tenant, and it never
 * invents a user.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000b1';
const TEAM = '0192f0ff-0000-7000-8000-00000000b001';

function requestWith(headers: Record<string, string | undefined>): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    headers: { cookie: headers.cookie },
  } as unknown as Request;
}

function sourceFinding(user: unknown): StubPrincipalSource {
  const prisma = {
    user: { findFirst: () => Promise.resolve(user) },
  } as unknown as TenantPrisma;

  return new StubPrincipalSource(prisma);
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
    const principal = await sourceFinding(SEEDED).resolve(
      requestWith({ cookie: `theme=dark; ${ROLE_STUB_COOKIE_NAME}=supervisor; other=x` }),
      TENANT,
    );

    expect(principal?.role).toBe('supervisor');
  });

  it('lets the header win over the cookie, for curl and integration tests', async () => {
    const principal = await sourceFinding(SEEDED).resolve(
      requestWith({
        [ROLE_STUB_HEADER]: 'agent',
        cookie: `${ROLE_STUB_COOKIE_NAME}=admin`,
      }),
      TENANT,
    );

    expect(principal?.role).toBe('agent');
  });

  // The property that keeps the stub from making TAR-81's tests meaningless: a
  // hardcoded tenant id would let every one of them pass with RLS never
  // exercised, which is the failure mode ADR 0002 warns about.
  it('takes the tenant from the caller, never from itself', async () => {
    const principal = await sourceFinding(SEEDED).resolve(requestWith({}), TENANT);

    expect(principal?.tenantId).toBe(TENANT);
  });

  it('takes the user and their teams from a real seeded row', async () => {
    const principal = await sourceFinding(SEEDED).resolve(requestWith({}), TENANT);

    expect(principal?.userId).toBe(SEEDED.id);
    expect(principal?.email).toBe(SEEDED.email);
    expect(principal?.teamIds).toEqual([TEAM]);
  });

  it('materialises permissions through the contract rather than listing them', async () => {
    for (const role of ['agent', 'supervisor', 'admin'] as const) {
      const principal = await sourceFinding(SEEDED).resolve(
        requestWith({ [ROLE_STUB_HEADER]: role }),
        TENANT,
      );

      expect(principal?.permissions).toEqual([...permissionsForRole(role)]);
    }
  });

  it('authenticates nobody when the tenant holds no active user with that role', async () => {
    // Refused as unauthenticated rather than fabricated — the stub supplies a
    // principal, it does not invent one.
    await expect(sourceFinding(null).resolve(requestWith({}), TENANT)).resolves.toBeNull();
  });
});
