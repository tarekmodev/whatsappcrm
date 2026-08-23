import { describe, expect, it } from 'vitest';
import {
  TENANT_STATUSES,
  type AdminTenantLifecycleEvent,
  type AdminTenantLifecycleResponse,
  type TenantStatus,
} from '@whatsappcrm/contracts';
import {
  currentStatusOf,
  knownDates,
  latestEventOf,
  tenantStatusTone,
  tenantWrites,
  upcomingDate,
} from './tenant-presentation';

/**
 * The console's one load-bearing inference — the admin API has no tenant read, so
 * "what state is this tenant in" is derived from the head of its trail — and the
 * writes that are offered from it.
 */

function event(overrides: Partial<AdminTenantLifecycleEvent> = {}): AdminTenantLifecycleEvent {
  return {
    id: '0192f00a-0000-7000-8000-00000000f001',
    fromStatus: 'active',
    toStatus: 'suspended',
    trigger: 'operator_action',
    actorType: 'platform_operator',
    actorLabel: 'ops-alice',
    occurredAt: '2026-08-23T09:00:00.000Z',
    reason: 'fraud, card chargeback',
    ...overrides,
  };
}

function lifecycle(
  overrides: Partial<AdminTenantLifecycleResponse> = {},
): AdminTenantLifecycleResponse {
  return {
    id: '0192f00a-0000-7000-8000-00000000e001',
    slug: 'northwind',
    name: 'Northwind Support',
    status: 'active',
    trialEndsAt: null,
    gracePeriodEndsAt: null,
    suspendedAt: null,
    cancelledAt: null,
    purgeAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('currentStatusOf', () => {
  /**
   * The trail comes back newest first — `LifecycleEventsRepository` orders by
   * `occurredAt desc, id desc` — so the head row is where the tenant is now.
   */
  it('reads the state off the newest row', () => {
    expect(
      currentStatusOf([
        event({ fromStatus: 'suspended', toStatus: 'active' }),
        event({ fromStatus: 'active', toStatus: 'suspended' }),
      ]),
    ).toBe('active');
  });

  /**
   * A tenant provisioned before `lifecycle_events` existed can have no rows at
   * all. Guessing `active` would have the console assert something it does not
   * know about a tenant somebody is about to suspend.
   */
  it('answers null rather than guessing when the trail is empty', () => {
    expect(currentStatusOf([])).toBeNull();
    expect(latestEventOf([])).toBeNull();
  });
});

describe('tenantStatusTone', () => {
  /**
   * Both read as wrong at a glance and are not: danger marks a state that wants
   * an operator's attention, and neither a purged tenant nor a half-provisioned
   * row wants anything.
   */
  it.each<TenantStatus>(['deleted', 'created'])('draws %s neutral, not danger', (status) => {
    expect(tenantStatusTone(status)).toBe('neutral');
  });

  it('draws the two states an operator has to act on in danger', () => {
    expect(tenantStatusTone('suspended')).toBe('danger');
    expect(tenantStatusTone('cancelled')).toBe('danger');
  });

  it.each(TENANT_STATUSES)('answers for %s', (status) => {
    expect(() => tenantStatusTone(status)).not.toThrow();
  });
});

describe('tenantWrites', () => {
  it('offers nothing on a tenant whose state could not be read', () => {
    expect(tenantWrites(null).isEmpty).toBe(true);
  });

  /**
   * The graph has no edge out of `deleted`, so the menu is omitted rather than
   * disabled — every entry would exist only to refuse.
   */
  it('offers nothing on a purged tenant', () => {
    expect(tenantWrites('deleted').isEmpty).toBe(true);
  });

  it('does not offer to reactivate a tenant that is already active', () => {
    const writes = tenantWrites('active');

    expect(writes.canReactivate).toBe(false);
    expect(writes.canSuspend).toBe(true);
  });

  it.each<TenantStatus>(['suspended', 'past_due', 'cancelled'])(
    'offers reactivation from %s, which is what the route exists to restore from',
    (status) => {
      expect(tenantWrites(status).canReactivate).toBe(true);
    },
  );

  /**
   * `trialing → active` is a legal edge, but a control labelled "Reactivate" on a
   * tenant running its trial describes something that is not happening — what it
   * would do is end the trial early.
   */
  it('does not offer reactivation on a trialing tenant, though the edge is legal', () => {
    expect(tenantWrites('trialing').canReactivate).toBe(false);
  });
});

describe('upcomingDate', () => {
  const NOW = Date.parse('2026-08-23T09:00:00.000Z');

  it('shows nothing when there is no lifecycle read yet', () => {
    expect(upcomingDate(null, NOW)).toBeNull();
  });

  /** Only while the date is in the future — a past deadline is history, not a chip. */
  it('ignores a date that has already passed', () => {
    expect(upcomingDate(lifecycle({ trialEndsAt: '2026-08-01T00:00:00.000Z' }), NOW)).toBeNull();
  });

  /**
   * Most-actionable first, and **one** — 0001 budgets a detail header at two
   * chips, one of which is the status. The others belong in the list below rather
   * than competing for the glance.
   */
  it('ranks the trial ahead of the grace period and the purge', () => {
    const upcoming = upcomingDate(
      lifecycle({
        trialEndsAt: '2026-09-01T00:00:00.000Z',
        gracePeriodEndsAt: '2026-08-25T00:00:00.000Z',
        purgeAt: '2026-10-01T00:00:00.000Z',
      }),
      NOW,
    );

    expect(upcoming?.kind).toBe('trialEndsAt');
  });

  it('falls through to the next date when the ranked one is absent', () => {
    const upcoming = upcomingDate(lifecycle({ purgeAt: '2026-10-01T00:00:00.000Z' }), NOW);

    expect(upcoming?.kind).toBe('purgeAt');
  });
});

describe('knownDates', () => {
  /** A null date renders no row — a list of "—" is a screen of absences. */
  it('drops every date the response does not carry', () => {
    expect(knownDates(lifecycle({ suspendedAt: '2026-08-20T00:00:00.000Z' }))).toEqual([
      { kind: 'suspendedAt', at: '2026-08-20T00:00:00.000Z' },
    ]);
  });

  it('is empty before any write has returned one', () => {
    expect(knownDates(null)).toEqual([]);
  });
});
