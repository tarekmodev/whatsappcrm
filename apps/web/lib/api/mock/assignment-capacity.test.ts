import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSIGNMENT_POLICY,
  type AssignmentSettingsResponse,
  type CursorPage,
  type TenantRole,
  type UserResponse,
} from '@whatsappcrm/contracts';

/**
 * The cap half of the mock transport (TAR-384, ADR 0008 decision 4).
 *
 * Three things are worth exercising here rather than assuming, because the
 * console's cap-edit control rests on all three and none is visible from the UI:
 * **the workspace default is tenant-scoped**, **a limit is only readable by
 * somebody who may tune routing**, and **`null` clears an override where an
 * omitted field leaves it alone**. A fixture layer that said yes to all of them
 * would let every one of those paths through review untested.
 *
 * `server-only` throws outside a React Server Component, and `next/headers` needs
 * a request scope — both are stubbed so these stay plain unit tests.
 */

vi.mock('server-only', () => ({}));

let currentRole: TenantRole = 'supervisor';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'wac_role_stub' ? { name, value: currentRole } : undefined),
    }),
}));

const { handleMockRequest } = await import('./handlers');
const { resetMockState } = await import('./store');
const { MOCK_IDS } = await import('./fixtures');
const { ApiRequestError } = await import('@/lib/api/http');

function asRole(role: TenantRole): void {
  currentRole = role;
}

async function readSettings(): Promise<AssignmentSettingsResponse> {
  return (await handleMockRequest({
    method: 'GET',
    path: '/v1/assignment-settings',
  })) as AssignmentSettingsResponse;
}

async function listAgents(): Promise<CursorPage<UserResponse>> {
  return (await handleMockRequest({
    method: 'GET',
    path: '/v1/users?limit=25&role=agent&status=active',
  })) as CursorPage<UserResponse>;
}

async function findAgent(id: string): Promise<UserResponse | undefined> {
  return (await listAgents()).items.find((user) => user.id === id);
}

async function patchCapacity(id: string, maxConcurrentTickets: number | null): Promise<void> {
  await handleMockRequest({
    method: 'PATCH',
    path: `/v1/users/${id}`,
    body: { maxConcurrentTickets },
  });
}

beforeEach(() => {
  resetMockState();
  asRole('supervisor');
});

describe('GET /v1/assignment-settings', () => {
  it('answers with the workspace default the fixtures seeded', async () => {
    await expect(readSettings()).resolves.toEqual({
      defaultMaxConcurrentTickets: ASSIGNMENT_POLICY.defaultMaxConcurrentTickets,
      updatedAt: '2026-08-01T09:00:00.000Z',
    });
  });

  /**
   * The gate is `assignment_rule:read`, not `user:read`: what an agent may hold is
   * a routing decision, and an agent holds neither permission.
   */
  it('refuses a caller who may not read routing configuration', async () => {
    asRole('agent');

    await expect(readSettings()).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe('assignmentCapacity on the people list', () => {
  it('publishes a limit, the effective cap and the live load to a supervisor', async () => {
    const amina = await findAgent(MOCK_IDS.users.amina);

    // Seeded with a limit equal to what she is already holding, so the flagged
    // queue's `all_at_capacity` row has somebody actually in the way.
    expect(amina?.assignmentCapacity).toEqual({
      maxConcurrentTickets: 1,
      effectiveMaxConcurrentTickets: 1,
      activeTicketCount: 1,
    });
  });

  it('coalesces an agent with no limit of their own onto the workspace default', async () => {
    const liang = await findAgent(MOCK_IDS.users.liang);

    expect(liang?.assignmentCapacity).toEqual({
      maxConcurrentTickets: null,
      effectiveMaxConcurrentTickets: ASSIGNMENT_POLICY.defaultMaxConcurrentTickets,
      activeTicketCount: 0,
    });
  });

  /**
   * `GET /v1/users` is `user:read`, which every agent holds. Flat cap fields would
   * hand any agent a live readout of a named colleague's workload and how close
   * they are to being cut off from work, so the whole object is withheld.
   */
  it('withholds every agent’s capacity from a caller who may not tune routing', async () => {
    asRole('agent');

    const agents = await listAgents();

    expect(agents.items.length).toBeGreaterThan(0);
    expect(agents.items.every((user) => user.assignmentCapacity === null)).toBe(true);
  });
});

describe('PATCH /v1/users/{id} with a limit', () => {
  it('raises the limit, and the effective cap follows it', async () => {
    await patchCapacity(MOCK_IDS.users.amina, 4);

    expect((await findAgent(MOCK_IDS.users.amina))?.assignmentCapacity).toMatchObject({
      maxConcurrentTickets: 4,
      effectiveMaxConcurrentTickets: 4,
    });
  });

  it('clears the override with null, returning the agent to the workspace default', async () => {
    await patchCapacity(MOCK_IDS.users.amina, null);

    expect((await findAgent(MOCK_IDS.users.amina))?.assignmentCapacity).toMatchObject({
      maxConcurrentTickets: null,
      effectiveMaxConcurrentTickets: ASSIGNMENT_POLICY.defaultMaxConcurrentTickets,
    });
  });

  /** Omitted is not `null`: another field's write must not clear a limit. */
  it('leaves the limit alone when the body does not carry it', async () => {
    await handleMockRequest({
      method: 'PATCH',
      path: `/v1/users/${MOCK_IDS.users.amina}`,
      body: { displayName: 'Amina H.' },
    });

    expect((await findAgent(MOCK_IDS.users.amina))?.assignmentCapacity).toMatchObject({
      maxConcurrentTickets: 1,
    });
  });

  it('refuses a value outside the bounds the contract publishes', async () => {
    for (const value of [
      ASSIGNMENT_POLICY.minMaxConcurrentTickets - 1,
      ASSIGNMENT_POLICY.maxMaxConcurrentTickets + 1,
    ]) {
      await expect(patchCapacity(MOCK_IDS.users.amina, value)).rejects.toBeInstanceOf(
        ApiRequestError,
      );
    }
  });
});
