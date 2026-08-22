import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BillingSummaryResponseSchema,
  HostedSessionSchema,
  PlanListResponseSchema,
  UsageSummaryResponseSchema,
  type BillingSummaryResponse,
  type PlanListResponse,
  type TenantRole,
  type UsageSummaryResponse,
} from '@whatsappcrm/contracts';

/**
 * The billing surface of the mock transport (TAR-37).
 *
 * These are the feature's acceptance criteria, not decoration. Four of them are
 * properties a broken implementation satisfies right up until a real tenant hits
 * them:
 *
 *   - the seat cap is refused **by the endpoint**, so the console's upgrade path
 *     is rendered from a refusal rather than from a count it guessed;
 *   - a plan whose ceilings are below current usage cannot be checked out — a
 *     downgrade must not strand a tenant over its own new cap *after* payment;
 *   - a checkout replayed with the same idempotency key opens one session, and
 *     replayed with a different body is refused;
 *   - activation copies the plan's entitlements into what enforcement reads, or
 *     a tenant is shown on Growth while still being refused its sixth seat.
 *
 * `server-only` throws outside a React Server Component, and `next/headers`
 * needs a request scope — both are stubbed so these stay plain unit tests.
 */

vi.mock('server-only', () => ({}));

let currentRole: TenantRole = 'admin';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'wac_role_stub' ? { name, value: currentRole } : undefined),
    }),
}));

const { handleMockRequest } = await import('./handlers');
const { resetMockState } = await import('./store');
const { MOCK_PLANS } = await import('./fixtures');
const { ApiRequestError } = await import('@/lib/api/http');

/**
 * Read out of the fixtures rather than written down here. A literal cap would
 * silently stop testing anything the next time the seed is retuned.
 */
const TRIAL_SEAT_CAP = MOCK_PLANS.find((plan) => plan.key === 'trial')?.entitlements.limits.seats;

/** A UUID, because the checkout route validates the key against `IdSchema`. */
const IDEMPOTENCY_KEY = '0192fdd0-0000-7000-8000-000000000001';
const OTHER_KEY = '0192fdd0-0000-7000-8000-000000000002';

beforeEach(() => {
  resetMockState();
  currentRole = 'admin';
});

describe('the plan catalogue', () => {
  it('validates against the published contract', async () => {
    const plans = await handleMockRequest({ method: 'GET', path: '/v1/billing/plans' });

    expect(PlanListResponseSchema.safeParse(plans).success).toBe(true);
  });

  it('marks the plan the tenant is on, even though it is not on sale', async () => {
    // `PlanSchema.isPublic` is "hidden from the pricing page but still honoured
    // for tenants already on it" — dropping it outright would leave a trialing
    // tenant looking at a plans page that does not contain its own plan.
    const { plans } = await listPlans();
    const trial = plans.find((plan) => plan.key === 'trial');

    expect(trial?.isCurrent).toBe(true);
    expect(trial?.isPublic).toBe(false);
  });

  it('never offers a non-public plan the tenant is not already on', async () => {
    const { plans } = await listPlans();

    expect(plans.every((plan) => plan.isPublic || plan.isCurrent)).toBe(true);
  });

  it('does not offer the current plan as something to buy again', async () => {
    const { plans } = await listPlans();

    expect(plans.find((plan) => plan.isCurrent)?.isSelectable).toBe(false);
  });

  it('refuses a plan whose ceilings sit below what the tenant already uses', async () => {
    // `solo` is seeded smaller than Northwind in both dimensions precisely so
    // this refusal is reachable rather than assumed.
    const { plans } = await listPlans();
    const solo = plans.find((plan) => plan.key === 'solo');

    expect(solo?.isSelectable).toBe(false);
    expect(solo?.blockedBy).toEqual(expect.arrayContaining(['seats', 'conversationsPerPeriod']));
  });

  it('offers a plan that comfortably covers current usage', async () => {
    const { plans } = await listPlans();
    const growth = plans.find((plan) => plan.key === 'growth');

    expect(growth?.isSelectable).toBe(true);
    expect(growth?.blockedBy).toEqual([]);
  });

  it('refuses the catalogue to a role without billing:read', async () => {
    currentRole = 'agent';

    await expect(handleMockRequest({ method: 'GET', path: '/v1/billing/plans' })).rejects.toThrow(
      ApiRequestError,
    );
  });
});

describe('the billing summary', () => {
  it('validates against the published contract', async () => {
    const summary = await handleMockRequest({ method: 'GET', path: '/v1/billing/subscription' });

    expect(BillingSummaryResponseSchema.safeParse(summary).success).toBe(true);
  });

  it('reports no subscription for a workspace still on its trial', async () => {
    // The state most tenants are in, and the one the console is most likely to
    // get wrong: `subscription` and `plan` are nullable exactly for it.
    const summary = await getSummary();

    expect(summary.subscription).toBeNull();
    expect(summary.plan).toBeNull();
  });

  it('still reports real limits without a subscription', async () => {
    const summary = await getSummary();

    expect(summary.entitlements.limits.seats).toBe(TRIAL_SEAT_CAP);
  });

  it('counts pending invitations as seats held', async () => {
    const before = await getSummary();

    await invite('newcomer@northwind.example');

    const after = await getSummary();

    expect(after.usage.seatsPending).toBe(before.usage.seatsPending + 1);
    expect(after.usage.seatsUsed).toBe(before.usage.seatsUsed);
  });
});

describe('usage counters', () => {
  it('validates against the published contract', async () => {
    const usage = await handleMockRequest({ method: 'GET', path: '/v1/billing/usage' });

    expect(UsageSummaryResponseSchema.safeParse(usage).success).toBe(true);
  });

  it('reports seats held rather than seats accepted, because that is what is billed', async () => {
    const [usage, summary] = await Promise.all([getUsage(), getSummary()]);
    const seats = usage.counters.find((counter) => counter.metric === 'seats_active');

    expect(seats?.value).toBe(summary.usage.seatsUsed + summary.usage.seatsPending);
  });

  it('agrees with the lifecycle endpoint about the same tenant’s seats', async () => {
    // Two endpoints answering different numbers for one tenant is a bug a
    // reviewer could only find by holding two pages side by side.
    const summary = await getSummary();
    const lifecycle = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tenant/lifecycle',
    })) as { usage: BillingSummaryResponse['usage'] };

    expect(lifecycle.usage).toEqual(summary.usage);
  });

  it('leaves an unmetered counter’s ceiling null rather than inventing one', async () => {
    const usage = await getUsage();

    expect(usage.counters.find((counter) => counter.metric === 'messages_sent')?.limit).toBeNull();
  });
});

describe('checkout', () => {
  it('returns a hosted session that satisfies the contract’s own schema', async () => {
    const session = await checkout('growth');

    expect(HostedSessionSchema.safeParse(session).success).toBe(true);
  });

  it('refuses a checkout with no idempotency key', async () => {
    await expect(
      handleMockRequest({
        method: 'POST',
        path: '/v1/billing/checkout',
        body: { planKey: 'growth' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('opens one session when the same key is replayed with the same body', async () => {
    const first = await checkout('growth');
    const second = await checkout('growth');

    expect(second).toEqual(first);
  });

  it('refuses a key already spent on a different body', async () => {
    await checkout('growth');

    await expect(checkout('starter')).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('refuses a plan smaller than what the tenant is already using', async () => {
    await expect(checkout('solo', OTHER_KEY)).rejects.toMatchObject({
      code: 'plan_limit_exceeded',
    });
  });

  it('does not disclose whether a plan that is not on sale exists', async () => {
    await expect(checkout('trial', OTHER_KEY)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('applies the subscription and reflects the new plan on the way back', async () => {
    await checkout('growth');

    const summary = await getSummary();

    expect(summary.subscription?.planKey).toBe('growth');
    expect(summary.subscription?.status).toBe('active');
    expect(summary.plan?.name).toBe('Growth');
  });

  it('copies the plan’s entitlements into what enforcement reads', async () => {
    // Without the copy, a tenant is shown on Growth while still being refused
    // its sixth seat — the half of activation that is easy to forget.
    await checkout('growth');

    const summary = await getSummary();

    expect(summary.entitlements.limits.seats).toBe(25);
    expect(summary.entitlements.features).toContain('workflows');
  });

  it('refuses a checkout to a role without billing:manage', async () => {
    currentRole = 'supervisor';

    await expect(checkout('growth')).rejects.toThrow(ApiRequestError);
  });
});

describe('the customer portal', () => {
  it('has nothing to open for a workspace that has never subscribed', async () => {
    await expect(
      handleMockRequest({ method: 'POST', path: '/v1/billing/portal' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns a hosted session once there is a subscription', async () => {
    await checkout('growth');

    const session = await handleMockRequest({ method: 'POST', path: '/v1/billing/portal' });

    expect(HostedSessionSchema.safeParse(session).success).toBe(true);
  });
});

describe('the seat cap on the invite endpoint', () => {
  /**
   * The acceptance criterion in one test: the refusal comes from the API, so the
   * console's upgrade path is rendered from it rather than from a count the
   * dialog kept for itself.
   */
  it('refuses the invitation that would exceed the allowance', async () => {
    await fillEverySeat();

    await expect(invite('one-too-many@northwind.example')).rejects.toMatchObject({
      code: 'plan_limit_exceeded',
      status: 409,
    });
  });

  it('names the way out, so the admin is not left re-pressing the button', async () => {
    await fillEverySeat();

    await expect(invite('one-too-many@northwind.example')).rejects.toThrow(/larger plan/i);
  });

  it('allows the invitation that fills the last seat', async () => {
    // The cap is reached *at* the allowance, not one short of it.
    await expect(fillEverySeat()).resolves.toBeDefined();
  });

  it('stops refusing once a bigger plan is in force', async () => {
    await fillEverySeat();
    await checkout('growth');

    await expect(invite('now-there-is-room@northwind.example')).resolves.toBeDefined();
  });
});

/** Sends invitations until seats held equals the plan's cap, and returns the last. */
async function fillEverySeat(): Promise<unknown> {
  let summary = await getSummary();
  let last: unknown;

  for (let index = 0; summary.usage.seatsUsed + summary.usage.seatsPending < 6; index += 1) {
    last = await invite(`filler-${index}@northwind.example`);
    summary = await getSummary();
  }

  return last;
}

function invite(email: string): Promise<unknown> {
  return handleMockRequest({
    method: 'POST',
    path: '/v1/users/invites',
    body: { email, role: 'agent', teamIds: [] },
  });
}

function checkout(planKey: string, key: string = IDEMPOTENCY_KEY): Promise<unknown> {
  return handleMockRequest({
    method: 'POST',
    path: '/v1/billing/checkout',
    body: { planKey },
    headers: { 'idempotency-key': key },
  });
}

async function listPlans(): Promise<PlanListResponse> {
  return PlanListResponseSchema.parse(
    await handleMockRequest({ method: 'GET', path: '/v1/billing/plans' }),
  );
}

async function getSummary(): Promise<BillingSummaryResponse> {
  return BillingSummaryResponseSchema.parse(
    await handleMockRequest({ method: 'GET', path: '/v1/billing/subscription' }),
  );
}

async function getUsage(): Promise<UsageSummaryResponse> {
  return UsageSummaryResponseSchema.parse(
    await handleMockRequest({ method: 'GET', path: '/v1/billing/usage' }),
  );
}
