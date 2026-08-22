import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DashboardMetricsResponseSchema,
  type DashboardMetricsResponse,
  type TenantRole,
} from '@whatsappcrm/contracts';

/**
 * The dashboard aggregate the console is built against — TAR-30, ADR 0010
 * (reporting dashboard and export) — standing in for TAR-428's query service.
 *
 * These are the rules whose failure is **silent** — a wrong number looks exactly
 * like a right one — so each is asserted rather than assumed:
 *
 *   1. Tenant isolation. The fixtures seed another tenant's late-answered ticket
 *      precisely so a lost scope would move the median by days.
 *   2. Event anchoring: resolution volume counts tickets *resolved* in the range,
 *      whenever they arrived and whatever status they hold now (decision 2).
 *   3. Attribution is historical, never the current assignee (decision 4).
 *   4. An empty range returns null durations, never zeros.
 *   5. Without `report:read_all`, the breakdown is one row (decision 6).
 *
 * `server-only` throws outside a React Server Component and `next/headers` needs
 * a request scope; both are stubbed the way `handlers.test.ts` stubs them, so
 * these stay plain unit tests.
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

function asRole(role: TenantRole): void {
  currentRole = role;
}

/** Wide enough to cover every fixture ticket, so a missing one is a real absence. */
const RANGE = { from: '2026-07-01', to: '2026-08-31' };
const ONE_DAY_SECONDS = 86_400;

async function dashboard(query: Record<string, string> = {}): Promise<DashboardMetricsResponse> {
  const params = new URLSearchParams({ ...RANGE, ...query });
  const response = await handleMockRequest({
    method: 'GET',
    path: `/v1/reports/dashboard?${params.toString()}`,
  });

  // Parsed against the contract rather than cast: a body the real endpoint could
  // not have produced has to fail here rather than reach a component.
  return DashboardMetricsResponseSchema.parse(response);
}

beforeEach(() => {
  resetMockState();
  asRole('supervisor');
});

describe('the dashboard aggregate', () => {
  it('never counts another tenant’s work', async () => {
    const metrics = await dashboard();

    // The other tenant's ticket was answered a fortnight late. If its rows
    // leaked, the median would move from minutes to days and no agent row would
    // account for it.
    expect(metrics.agents.map((row) => row.userId)).not.toContain(MOCK_IDS.users.otherTenant);
    expect(metrics.summary.firstResponse.medianSeconds).toBeLessThan(ONE_DAY_SECONDS);
  });

  it('counts a resolution in the range it happened in, whatever status the ticket holds now', async () => {
    const metrics = await dashboard();

    // One ticket resolved and still resolved, plus one resolved in July and
    // closed in August. Anchoring on status rather than on `resolvedAt` would
    // lose the second and under-report the team by half.
    expect(metrics.summary.volume.resolved).toBe(2);
    expect(metrics.summary.resolution.count).toBe(2);
  });

  it('keeps closed-unworked out of the resolved count', async () => {
    const metrics = await dashboard();

    // Folding it in would inflate a client-facing number with spam and wrong
    // numbers, which is exactly what the separate count exists to prevent.
    expect(metrics.summary.volume.closedWithoutResolution).toBe(1);
  });

  it('attributes a resolution to whoever resolved it, not to the assignee', async () => {
    const metrics = await dashboard();
    const priya = metrics.agents.find((row) => row.userId === MOCK_IDS.users.priya);
    const amina = metrics.agents.find((row) => row.userId === MOCK_IDS.users.amina);

    // The ticket is assigned to Amina and was resolved by Priya. Attributing to
    // the assignee would rewrite a closed period's numbers the next time that
    // ticket was reassigned.
    expect(priya?.ticketsResolved).toBe(1);
    expect(amina?.ticketsResolved).toBe(0);
    // Amina still owns the first responses she actually made.
    expect(amina?.firstResponse.count).toBeGreaterThan(0);
  });

  it('renders work with no recorded agent as its own row rather than redistributing it', async () => {
    const metrics = await dashboard();
    const unattributed = metrics.agents.find((row) => row.userId === null);

    expect(unattributed?.name).toBeNull();
    expect(unattributed?.firstResponse.count).toBe(1);
  });

  it('zero-fills every active member, so a quiet week is not an absent row', async () => {
    const metrics = await dashboard();
    const ids = metrics.agents.map((row) => row.userId);

    expect(ids).toContain(MOCK_IDS.users.omar);
    // An invited-but-unaccepted account is not an agent yet, and a row for
    // somebody who has never logged in reads as a bug.
    expect(ids).not.toContain(MOCK_IDS.users.noor);
  });

  it('returns null durations for an empty range, never zeros', async () => {
    const metrics = await dashboard({ from: '2026-01-01', to: '2026-01-31' });

    expect(metrics.summary.volume).toEqual({ created: 0, resolved: 0, closedWithoutResolution: 0 });
    // "Nothing was answered" and "everything was answered instantly" are
    // different facts, and the contract refuses a body that confuses them.
    expect(metrics.summary.firstResponse.medianSeconds).toBeNull();
    expect(metrics.summary.resolution.averageSeconds).toBeNull();
  });

  it('carries every day of the range, so a gap in the chart is a quiet day', async () => {
    const metrics = await dashboard({ from: '2026-08-01', to: '2026-08-07' });

    expect(metrics.series).toHaveLength(7);
    expect(metrics.series.at(0)?.date).toBe('2026-08-01');
    expect(metrics.series.at(-1)?.date).toBe('2026-08-07');
  });

  it('refuses a backwards range and one over the cap before any aggregation runs', async () => {
    await expect(dashboard({ from: '2026-08-31', to: '2026-07-01' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(dashboard({ from: '2024-01-01', to: '2026-08-31' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('an agent’s dashboard', () => {
  beforeEach(() => {
    asRole('agent');
  });

  it('breaks nothing out by colleague — one row, their own', async () => {
    const metrics = await dashboard();

    // ADR 0010 (reporting dashboard and export) decision 6. The aggregate still
    // covers what they can see; what is withheld is the comparison against the
    // people they work with.
    expect(metrics.agents.map((row) => row.userId)).not.toContain(MOCK_IDS.users.priya);
    expect(
      metrics.agents.every((row) => row.userId === MOCK_IDS.users.amina || row.userId === null),
    ).toBe(true);
  });

  it('is narrowed rather than refused when it asks for the whole workspace', async () => {
    const metrics = await dashboard({ scope: 'all' });

    // A supervisor's shared link still renders, with less in it — and the
    // response reports the scope that was served rather than the one asked for.
    expect(metrics.scope).toBe('assigned');
  });
});
