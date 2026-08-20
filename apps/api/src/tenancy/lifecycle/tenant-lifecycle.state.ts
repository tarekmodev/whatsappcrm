import {
  LIFECYCLE_POLICY,
  TENANT_STATUS_TRANSITIONS,
  canTransitionTenant,
  type LifecycleTrigger,
  type TenantStatus,
} from '@whatsappcrm/contracts';

/**
 * The state machine's rules, as data — separated from the service that applies
 * them so they can be read, and tested, without a database.
 *
 * Everything here is derived from ADR 0009's state diagram and decision 4. The
 * *edges* live in `TENANT_STATUS_TRANSITIONS` in the contract package, because
 * the console renders them too; what lives here is the half a frontend has no
 * use for — which trigger may cause which edge, and which timer columns each
 * arrival writes.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Which triggers may cause each edge (0009, "Every edge is triggered by exactly
 * one of three things ... and the transition function refuses an edge whose
 * trigger is not the one recorded for it").
 *
 * This is the rule that makes `active → past_due` from a UI button a bug rather
 * than a shortcut. Without it `trigger` is a field every writer fills in
 * truthfully by convention, and a convention is not an audit trail.
 *
 * The map's shape is checked against `TENANT_STATUS_TRANSITIONS` at module load
 * below, so an edge added to the contract and forgotten here fails at boot
 * rather than at the first request that needs it.
 *
 * Three entries are worth their reasoning:
 *
 *   * **`* → suspended` admits `operator_action` as well as `timer`.** The
 *     diagram draws `past_due → suspended` as the grace period elapsing, and it
 *     is — but `POST /admin/tenants/{slug}/deactivate` reaches the same state
 *     from wherever the tenant happens to be, and a right-to-erasure request
 *     that cannot wait 44 days reaches it through `force`. Refusing the operator
 *     on that one edge would mean an operator could deactivate an `active`
 *     tenant and not a `past_due` one.
 *   * **`* → active` admits `billing_event` and the two human triggers.** A
 *     payment succeeding and an operator reactivating are the two ways back, and
 *     0009 names both on the same edge.
 *   * **`suspended → deleted` admits only `timer`.** There is one road to
 *     `deleted` and one clock on it. An operator who wants a tenant gone sooner
 *     moves `purge_at`, which is what `force` does — they do not get a second
 *     path to the one irreversible state.
 */
export const EDGE_TRIGGERS: Readonly<
  Record<TenantStatus, Readonly<Partial<Record<TenantStatus, readonly LifecycleTrigger[]>>>>
> = {
  // Provisioning commits both of these inside the transaction that inserts the
  // row, so in practice nothing reaches them through `transition()`. They are
  // here so that a tenant left in `created` by a half-applied provision can be
  // moved on deliberately rather than being unreachable.
  created: { trialing: ['system'], active: ['system'] },
  trialing: {
    active: ['billing_event', 'operator_action'],
    past_due: ['timer', 'billing_event'],
    cancelled: ['user_action', 'operator_action', 'billing_event'],
    suspended: ['operator_action'],
  },
  active: {
    past_due: ['billing_event'],
    cancelled: ['user_action', 'operator_action', 'billing_event'],
    suspended: ['operator_action'],
  },
  past_due: {
    active: ['billing_event', 'operator_action'],
    suspended: ['timer', 'operator_action'],
    cancelled: ['user_action', 'operator_action', 'billing_event'],
  },
  suspended: {
    active: ['billing_event', 'operator_action'],
    cancelled: ['user_action', 'operator_action', 'billing_event'],
    deleted: ['timer'],
  },
  cancelled: {
    active: ['user_action', 'operator_action', 'billing_event'],
    suspended: ['timer', 'operator_action'],
  },
  deleted: {},
};

/**
 * Fails at module load if `EDGE_TRIGGERS` and `TENANT_STATUS_TRANSITIONS` have
 * come apart.
 *
 * The two describe the same graph from two sides, and the failure mode of
 * letting them drift is silent in both directions: an edge here that the
 * contract does not publish is one the console will never offer, and an edge
 * there with no entry here is one every trigger is refused for — which reads, at
 * the call site, exactly like the state machine working.
 */
for (const [from, targets] of Object.entries(TENANT_STATUS_TRANSITIONS)) {
  const declared = Object.keys(EDGE_TRIGGERS[from as TenantStatus]);
  const published = [...targets];

  if (declared.length !== published.length || !published.every((to) => declared.includes(to))) {
    throw new Error(
      `EDGE_TRIGGERS disagrees with TENANT_STATUS_TRANSITIONS for ${from}: ` +
        `published [${published.join(', ')}], declared [${declared.join(', ')}].`,
    );
  }
}

export type TransitionRefusal = 'edge_not_allowed' | 'trigger_not_allowed' | null;

/** `null` when the transition is legal. Otherwise which of the two rules refused it. */
export function refuseTransition(
  from: TenantStatus,
  to: TenantStatus,
  trigger: LifecycleTrigger,
): TransitionRefusal {
  if (!canTransitionTenant(from, to)) {
    return 'edge_not_allowed';
  }

  return EDGE_TRIGGERS[from][to]?.includes(trigger) === true ? null : 'trigger_not_allowed';
}

/**
 * Every column a transition may write, other than `status` itself. Absent means
 * "leave it alone"; `null` means "clear it".
 */
export interface TimerColumns {
  trialEndsAt?: Date | null;
  gracePeriodEndsAt?: Date | null;
  suspendedAt?: Date | null;
  cancelledAt?: Date | null;
  purgeAt?: Date | null;
  deletedAt?: Date | null;
  trialEndingNotifiedAt?: null;
  deletionReminderNotifiedAt?: null;
}

/**
 * The timer columns an arrival at `to` from `from` writes (0009 decision 4).
 *
 * Two rules, applied in that order, and the second is the one that is easy to
 * leave out:
 *
 *   1. **Arriving somewhere starts that state's clock.** `past_due` and
 *      `cancelled` start a grace period, `suspended` starts the retention
 *      window, `deleted` stamps the tombstone.
 *   2. **Leaving somewhere stops the clock it started.** A `past_due` tenant
 *      that pays has `grace_period_ends_at` set back to NULL in the same
 *      transaction as the status write, because a stale timer is a tenant that
 *      gets suspended a fortnight after it paid. The same for `trial_ends_at` on
 *      leaving `trialing` and `purge_at` on leaving `suspended` — a reactivated
 *      tenant with a live `purge_at` is a tenant the next sweep deletes.
 *
 * `suspended_at` and `cancelled_at` are deliberately **not** cleared. They are
 * historical stamps rather than timers — "when did they leave" is a question
 * support still has to answer after a reactivation, and the schema says so on
 * both columns.
 *
 * ### On recomputing `purge_at` rather than stamping it
 *
 * 0009's open question 1 muses that `purge_at` could be derived from
 * `suspended_at + purgeAfterSuspendedDays` on read, so that revising the
 * constant re-dates purges that have not run. This stamps the instant instead,
 * for two reasons that are both about what shipped: the schema comment on
 * `grace_period_ends_at` makes the opposite ruling explicitly — "only the
 * instant lives here ... stops it silently reinterpreting a timer already
 * running for a live tenant" — and `tenants_purge_due` is an index on the
 * column, which a derived value could not use. Shortening the window for tenants
 * already suspended is therefore a deliberate one-off `UPDATE` rather than a
 * constant edit, and that is the safer direction for the only irreversible timer
 * in the product.
 */
export function timerColumnsFor(from: TenantStatus, to: TenantStatus, now: Date): TimerColumns {
  const columns: TimerColumns = {};

  // 1. Leaving a state stops the clock that state started.
  if (from === 'trialing') {
    columns.trialEndsAt = null;
    columns.trialEndingNotifiedAt = null;
  }

  if (from === 'past_due' || from === 'cancelled') {
    columns.gracePeriodEndsAt = null;
  }

  if (from === 'suspended') {
    columns.purgeAt = null;
    columns.deletionReminderNotifiedAt = null;
  }

  // 2. Arriving somewhere starts its own.
  switch (to) {
    case 'trialing':
      columns.trialEndsAt = new Date(now.getTime() + LIFECYCLE_POLICY.trialDays * DAY_MS);
      columns.trialEndingNotifiedAt = null;
      break;

    case 'past_due':
      columns.gracePeriodEndsAt = new Date(
        now.getTime() + LIFECYCLE_POLICY.pastDueGraceDays * DAY_MS,
      );
      break;

    case 'cancelled':
      columns.cancelledAt = now;
      columns.gracePeriodEndsAt = new Date(
        now.getTime() + LIFECYCLE_POLICY.cancelledGraceDays * DAY_MS,
      );
      break;

    case 'suspended':
      columns.suspendedAt = now;
      columns.purgeAt = new Date(now.getTime() + LIFECYCLE_POLICY.purgeAfterSuspendedDays * DAY_MS);
      columns.deletionReminderNotifiedAt = null;
      break;

    case 'deleted':
      // The `tenants` row survives as the slug tombstone; every forward-looking
      // timer on it is spent. `tenants_deleted_at_matches_status` makes this
      // stamp and the status agree in both directions.
      columns.deletedAt = now;
      columns.purgeAt = null;
      columns.gracePeriodEndsAt = null;
      break;

    default:
      break;
  }

  return columns;
}
