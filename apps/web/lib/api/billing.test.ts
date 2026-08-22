import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanListItem } from '@whatsappcrm/contracts';
import { MalformedResponseError } from '@/lib/api/parse';
import { getBillingPlans } from './billing';

/**
 * What `GET /v1/billing/plans` does with a response the contract refuses
 * (TAR-657).
 *
 * The catalogue is platform-wide and the route returns all of it, so one bad row
 * reaches every tenant's billing page at once. Parsing the array as a unit made
 * that row the page's error boundary for the whole platform — plans, usage,
 * seat messaging and the portal link — with nothing on screen to recover from.
 *
 * So the rule this file pins down is a narrow one: **a bad plan costs its own
 * card and nothing else**, and anything the page cannot render without is still
 * a hard failure. The database now refuses the row that caused it; this is what
 * holds when the next unforeseen one is not refused.
 */

const { authenticatedRequest } = vi.hoisted(() => ({ authenticatedRequest: vi.fn() }));

vi.mock('@/lib/api/authenticated', () => ({ authenticatedRequest }));

const USAGE = { seatsUsed: 2, seatsPending: 1, conversationsThisPeriod: 40 };

function plan(overrides: Partial<PlanListItem> = {}): PlanListItem {
  return {
    id: '0192fdd0-0000-7000-8000-000000000001',
    key: 'growth',
    name: 'Growth',
    pricePerSeat: { amountMinor: 7900, currency: 'USD' },
    interval: 'month',
    entitlements: {
      features: ['workflows'],
      limits: {
        seats: 10,
        conversationsPerPeriod: 10_000,
        whatsappNumbers: 3,
        teams: 10,
        knowledgeDocuments: 100,
      },
    },
    isPublic: true,
    isCurrent: false,
    isSelectable: true,
    blockedBy: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('getBillingPlans', () => {
  it('returns every plan when the catalogue matches the contract', async () => {
    authenticatedRequest.mockResolvedValue({
      plans: [plan(), plan({ id: '0192fdd0-0000-7000-8000-000000000002', key: 'starter' })],
      usage: USAGE,
    });

    const response = await getBillingPlans();

    expect(response.plans.map(({ key }) => key)).toEqual(['growth', 'starter']);
    expect(response.usage).toEqual(USAGE);
  });

  it('drops the one plan whose key the contract refuses and keeps the rest', async () => {
    // The row that caused TAR-657: a test fixture keyed with hyphens, left
    // behind in a table every tenant reads.
    authenticatedRequest.mockResolvedValue({
      plans: [plan({ id: '0192fdd0-0000-7000-8000-000000000003', key: 'tar405-cap-plan' }), plan()],
      usage: USAGE,
    });

    const response = await getBillingPlans();

    expect(response.plans.map(({ key }) => key)).toEqual(['growth']);
  });

  it('drops a plan malformed anywhere else, not only in its key', async () => {
    authenticatedRequest.mockResolvedValue({
      plans: [
        plan({
          id: '0192fdd0-0000-7000-8000-000000000004',
          key: 'legacy',
          // `null` is unlimited; a negative ceiling is a number no comparison
          // site should ever be handed.
          entitlements: {
            features: [],
            limits: {
              seats: -5,
              conversationsPerPeriod: null,
              whatsappNumbers: null,
              teams: null,
              knowledgeDocuments: null,
            },
          },
        }),
        plan(),
      ],
      usage: USAGE,
    });

    await expect(getBillingPlans()).resolves.toMatchObject({ plans: [{ key: 'growth' }] });
  });

  it('logs the plan it dropped, so the bad row can be found in the catalogue', async () => {
    authenticatedRequest.mockResolvedValue({
      plans: [plan({ key: 'tar405-cap-plan' })],
      usage: USAGE,
    });

    await getBillingPlans();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('does not match the contract'),
      { key: 'tar405-cap-plan' },
      expect.anything(),
    );
  });

  it('still fails when the usage the page renders beside the plans is malformed', async () => {
    // Not tolerated, deliberately: these are the numbers the seat and volume
    // messaging is computed from, and inventing them would be a tenant told it
    // can invite somebody it cannot.
    authenticatedRequest.mockResolvedValue({ plans: [plan()], usage: { seatsUsed: 2 } });

    await expect(getBillingPlans()).rejects.toThrow();
  });

  it('fails when the envelope is not a plan list at all', async () => {
    authenticatedRequest.mockResolvedValue({ items: [] });

    await expect(getBillingPlans()).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it('returns an empty list rather than throwing when every plan is malformed', async () => {
    // A catalogue nothing can be bought from is a real answer the page renders
    // as "no plans", not a crash. The alternative reads as an outage.
    authenticatedRequest.mockResolvedValue({ plans: [{ key: 'oops' }], usage: USAGE });

    await expect(getBillingPlans()).resolves.toMatchObject({ plans: [], usage: USAGE });
  });
});
