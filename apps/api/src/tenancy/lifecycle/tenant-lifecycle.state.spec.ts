import {
  LIFECYCLE_POLICY,
  LIFECYCLE_TRIGGERS,
  TENANT_STATUSES,
  TENANT_STATUS_TRANSITIONS,
  type LifecycleTrigger,
  type TenantStatus,
} from '@whatsappcrm/contracts';
import { EDGE_TRIGGERS, refuseTransition, timerColumnsFor } from './tenant-lifecycle.state';

/**
 * The state machine's rules, with no database and no framework in the way.
 *
 * Every edge in ADR 0009's diagram, every edge that is *not* in it, and every
 * trigger that may or may not cause one — asserted exhaustively rather than by
 * example, because the failure mode of a missing case here is silent: an edge
 * with no entry is one every trigger is refused for, which reads at the call
 * site exactly like the state machine working.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = new Date('2026-08-16T12:00:00.000Z');

/** Every ordered pair of statuses, so nothing can be tested by omission. */
const ALL_PAIRS: [TenantStatus, TenantStatus][] = TENANT_STATUSES.flatMap((from) =>
  TENANT_STATUSES.map((to): [TenantStatus, TenantStatus] => [from, to]),
);

function isPublishedEdge(from: TenantStatus, to: TenantStatus): boolean {
  return TENANT_STATUS_TRANSITIONS[from].includes(to);
}

describe('the tenant lifecycle state machine', () => {
  describe('which edges exist', () => {
    it.each(ALL_PAIRS.filter(([from, to]) => !isPublishedEdge(from, to)))(
      'refuses %s → %s, whatever caused it',
      (from, to) => {
        for (const trigger of LIFECYCLE_TRIGGERS) {
          expect(refuseTransition(from, to, trigger)).toBe('edge_not_allowed');
        }
      },
    );

    it.each(ALL_PAIRS.filter(([from, to]) => isPublishedEdge(from, to)))(
      'admits %s → %s for at least one trigger',
      (from, to) => {
        const admitted = LIFECYCLE_TRIGGERS.filter(
          (trigger) => refuseTransition(from, to, trigger) === null,
        );

        // An edge nothing may cause is an edge that does not exist, spelled in a
        // way nobody notices.
        expect(admitted.length).toBeGreaterThan(0);
      },
    );

    it('leaves `deleted` with no way out', () => {
      // `contract.test.ts` asserts the same thing on the published map. It is
      // restated here because it is the one rule whose violation is a
      // data-retention incident rather than a bug: a tenant that came back from
      // `deleted` would be one whose rows were not actually deleted.
      for (const to of TENANT_STATUSES) {
        for (const trigger of LIFECYCLE_TRIGGERS) {
          expect(refuseTransition('deleted', to, trigger)).toBe('edge_not_allowed');
        }
      }
    });

    it('has exactly one road to `deleted`, and it is a timer', () => {
      const roads = TENANT_STATUSES.filter((from) =>
        LIFECYCLE_TRIGGERS.some((trigger) => refuseTransition(from, 'deleted', trigger) === null),
      );

      expect(roads).toEqual(['suspended']);
      expect(EDGE_TRIGGERS.suspended.deleted).toEqual(['timer']);
    });
  });

  describe('which trigger may cause which edge', () => {
    it('refuses `active → past_due` from a button', () => {
      // The rule the `trigger` column exists to make assertable (0009, proposed
      // architecture). Dunning starts because a payment failed, not because
      // somebody in a console said so.
      expect(refuseTransition('active', 'past_due', 'user_action')).toBe('trigger_not_allowed');
      expect(refuseTransition('active', 'past_due', 'operator_action')).toBe('trigger_not_allowed');
      expect(refuseTransition('active', 'past_due', 'billing_event')).toBeNull();
    });

    it('refuses a timer on any edge a clock cannot cause', () => {
      expect(refuseTransition('active', 'cancelled', 'timer')).toBe('trigger_not_allowed');
      expect(refuseTransition('suspended', 'active', 'timer')).toBe('trigger_not_allowed');
    });

    it('admits the three timers the sweep actually fires', () => {
      expect(refuseTransition('trialing', 'past_due', 'timer')).toBeNull();
      expect(refuseTransition('past_due', 'suspended', 'timer')).toBeNull();
      expect(refuseTransition('cancelled', 'suspended', 'timer')).toBeNull();
      expect(refuseTransition('suspended', 'deleted', 'timer')).toBeNull();
    });

    it('lets an operator reach `suspended` from wherever the tenant is', () => {
      // `POST /admin/tenants/{slug}/deactivate` is one endpoint, and refusing it
      // on `past_due` alone would make it work for an active tenant and not for
      // one whose card had failed.
      for (const from of ['trialing', 'active', 'past_due'] as const) {
        expect(refuseTransition(from, 'suspended', 'operator_action')).toBeNull();
      }
    });

    it('lets an admin undo a cancellation, and a payment do the same', () => {
      expect(refuseTransition('cancelled', 'active', 'user_action')).toBeNull();
      expect(refuseTransition('cancelled', 'active', 'billing_event')).toBeNull();
    });

    it('does not let a user_action lift a suspension', () => {
      // The way back from `suspended` is a payment or an operator. An admin
      // pressing "undo" is neither, and the console's copy says so.
      expect(refuseTransition('suspended', 'active', 'user_action')).toBe('trigger_not_allowed');
    });

    it('agrees with the published transition map, edge for edge', () => {
      // `tenant-lifecycle.state.ts` asserts this at module load, which is what
      // makes a drifted map a boot failure. Restated here so the failure names
      // the two maps rather than arriving as an import error in an unrelated
      // suite.
      for (const from of TENANT_STATUSES) {
        expect(Object.keys(EDGE_TRIGGERS[from]).sort()).toEqual(
          [...TENANT_STATUS_TRANSITIONS[from]].sort(),
        );
      }
    });

    it('names only triggers the contract publishes', () => {
      const named = new Set<LifecycleTrigger>(
        Object.values(EDGE_TRIGGERS).flatMap((targets) => Object.values(targets).flat()),
      );

      for (const trigger of named) {
        expect(LIFECYCLE_TRIGGERS).toContain(trigger);
      }
    });
  });

  describe('the timer columns an arrival writes', () => {
    it('starts the dunning window on `past_due`', () => {
      const columns = timerColumnsFor('active', 'past_due', NOW);

      expect(columns.gracePeriodEndsAt).toEqual(
        new Date(NOW.getTime() + LIFECYCLE_POLICY.pastDueGraceDays * DAY_MS),
      );
      expect(columns.purgeAt).toBeUndefined();
    });

    it('starts the cancellation window and stamps when they left', () => {
      const columns = timerColumnsFor('active', 'cancelled', NOW);

      expect(columns.cancelledAt).toEqual(NOW);
      expect(columns.gracePeriodEndsAt).toEqual(
        new Date(NOW.getTime() + LIFECYCLE_POLICY.cancelledGraceDays * DAY_MS),
      );
    });

    it('starts the retention window on `suspended`, and only there', () => {
      const columns = timerColumnsFor('past_due', 'suspended', NOW);

      expect(columns.suspendedAt).toEqual(NOW);
      expect(columns.purgeAt).toEqual(
        new Date(NOW.getTime() + LIFECYCLE_POLICY.purgeAfterSuspendedDays * DAY_MS),
      );
      // Leaving `past_due` stops the clock that state started. A stale timer is
      // a tenant that gets moved on twice.
      expect(columns.gracePeriodEndsAt).toBeNull();
    });

    it('clears every forward-looking timer when a tenant is reactivated', () => {
      // The bug this prevents: a tenant that pays, is restored, and is then
      // purged a fortnight later by a `purge_at` nobody cleared.
      const fromSuspended = timerColumnsFor('suspended', 'active', NOW);
      expect(fromSuspended.purgeAt).toBeNull();

      const fromPastDue = timerColumnsFor('past_due', 'active', NOW);
      expect(fromPastDue.gracePeriodEndsAt).toBeNull();

      const fromCancelled = timerColumnsFor('cancelled', 'active', NOW);
      expect(fromCancelled.gracePeriodEndsAt).toBeNull();
    });

    it('keeps `suspended_at` and `cancelled_at` through a reactivation', () => {
      // Historical stamps, not timers: "when did they leave" is a question
      // support still has to answer after a tenant comes back.
      const columns = timerColumnsFor('suspended', 'active', NOW);

      expect(columns.suspendedAt).toBeUndefined();
      expect(columns.cancelledAt).toBeUndefined();
    });

    it('ends the trial clock when the trial ends, however it ends', () => {
      for (const to of ['active', 'past_due', 'cancelled', 'suspended'] as const) {
        expect(timerColumnsFor('trialing', to, NOW).trialEndsAt).toBeNull();
      }
    });

    it('re-arms both reminders when the timer they belong to restarts', () => {
      // A tenant that is reactivated and suspended again is owed a second
      // deletion reminder: the retention window is a new one.
      expect(timerColumnsFor('past_due', 'suspended', NOW).deletionReminderNotifiedAt).toBeNull();
      expect(timerColumnsFor('created', 'trialing', NOW).trialEndingNotifiedAt).toBeNull();
    });

    it('stamps the tombstone and spends every timer on `deleted`', () => {
      const columns = timerColumnsFor('suspended', 'deleted', NOW);

      expect(columns.deletedAt).toEqual(NOW);
      expect(columns.purgeAt).toBeNull();
      expect(columns.gracePeriodEndsAt).toBeNull();
    });

    it('gives a fresh trial its published length', () => {
      expect(timerColumnsFor('created', 'trialing', NOW).trialEndsAt).toEqual(
        new Date(NOW.getTime() + LIFECYCLE_POLICY.trialDays * DAY_MS),
      );
    });
  });
});
