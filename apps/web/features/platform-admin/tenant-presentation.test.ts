import { describe, expect, it } from 'vitest';
import {
  TENANT_STATUSES,
  type AdminTenantLifecycleEvent,
  type TenantStatus,
} from '@whatsappcrm/contracts';
import { currentStatusOf, latestEventOf, tenantActions } from './tenant-presentation';

/**
 * The console's one load-bearing inference: the admin API has no tenant read, so
 * "what state is this tenant in" is derived from the head of its trail — and the
 * two operator actions are offered from that.
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

describe('currentStatusOf', () => {
  /**
   * `GET /admin/tenants/{slug}/lifecycle` returns newest first, so the head row
   * is where the tenant is now — every transition writes a row inside the
   * transaction that makes it.
   */
  it('reads the state off the newest row', () => {
    expect(
      currentStatusOf([
        event({ toStatus: 'active', fromStatus: 'suspended' }),
        event({ toStatus: 'suspended', fromStatus: 'active' }),
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

describe('tenantActions', () => {
  it('offers neither action on a tenant whose state could not be read', () => {
    expect(tenantActions(null)).toEqual({ canSuspend: false, canReactivate: false });
  });

  /** `TENANT_STATUS_TRANSITIONS` has no `active → active` edge. */
  it('does not offer to reactivate a tenant that is already active', () => {
    expect(tenantActions('active').canReactivate).toBe(false);
    expect(tenantActions('active').canSuspend).toBe(true);
  });

  it.each<TenantStatus>(['suspended', 'past_due', 'cancelled'])(
    'offers reactivation from %s, which is what the route exists to restore from',
    (status) => {
      expect(tenantActions(status).canReactivate).toBe(true);
    },
  );

  /**
   * `trialing → active` is a legal edge and the route would take it, but a
   * button labelled "Reactivate tenant" on a tenant that is running its trial
   * describes something that is not happening — it would end the trial early.
   */
  it('does not offer reactivation on a trialing tenant, though the edge is legal', () => {
    expect(tenantActions('trialing').canReactivate).toBe(false);
  });

  it.each<TenantStatus>(['created', 'deleted'])(
    'offers neither action from %s, where the graph allows neither',
    (status) => {
      expect(tenantActions(status)).toEqual({ canSuspend: false, canReactivate: false });
    },
  );

  /** Nothing here may throw on a status the contract publishes. */
  it.each(TENANT_STATUSES)('answers for %s', (status) => {
    expect(() => tenantActions(status)).not.toThrow();
  });
});
