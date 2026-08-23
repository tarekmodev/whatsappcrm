import {
  TENANT_STATUS_TRANSITIONS,
  type AdminTenantLifecycleEvent,
  type TenantStatus,
} from '@whatsappcrm/contracts';
import type { BadgeTone } from '@/components/ui/Badge';

/**
 * How a tenant's lifecycle reads on the operator console: what state it is in,
 * and which of the two operator actions that state allows.
 *
 * Pure functions in one module rather than logic in a component, because the
 * derivation below is the console's single load-bearing inference and three
 * surfaces read it — the status chip, the action row, and the tests that pin
 * both.
 */

/**
 * Where the tenant is now, read off the newest row of its trail.
 *
 * **This is a derivation, not a read**, and it is here because the admin API
 * offers no other answer: there is no `GET /admin/tenants/{slug}`, and the four
 * routes that *do* report a status are all writes. `GET /admin/tenants/{slug}/lifecycle`
 * returns the trail newest first, so the head row's `toStatus` is the current
 * state — every transition writes a row inside the transaction that makes it, so
 * there is no state the trail does not carry.
 *
 * `null` for a tenant with no rows at all. That is a real case rather than a
 * fault: `lifecycle_events` was added after tenants existed, and the backfill
 * writes one `unattributed` row per tenant — but a tenant whose backfill row was
 * never written has an empty trail, and inventing `active` for it would be the
 * console asserting something it does not know about a tenant an operator is
 * about to act on.
 */
export function currentStatusOf(events: readonly AdminTenantLifecycleEvent[]): TenantStatus | null {
  return events[0]?.toStatus ?? null;
}

/** The newest row, or `null` — what "last changed" and its actor are read from. */
export function latestEventOf(
  events: readonly AdminTenantLifecycleEvent[],
): AdminTenantLifecycleEvent | null {
  return events[0] ?? null;
}

/**
 * The chip's tone. Intent, not colour: the label always carries the meaning in
 * words, so this only decides how loudly the row asks to be looked at.
 *
 * `created` is `warning` rather than `neutral`, matching what the tenant-facing
 * copy says about it: a tenant is only in that state between its row appearing
 * and provisioning finishing, both inside one transaction, so an operator seeing
 * it is looking at a provision that stopped halfway.
 */
export function tenantStatusTone(status: TenantStatus): BadgeTone {
  switch (status) {
    case 'active':
      return 'success';
    case 'trialing':
      return 'info';
    case 'created':
    case 'past_due':
    case 'cancelled':
      return 'warning';
    case 'suspended':
    case 'deleted':
      return 'danger';
  }
}

/**
 * The three states reactivation is *for*: the ones an operator or an automated
 * timer put a working tenant into.
 *
 * Narrower than the transition table, and deliberately. `trialing → active` is a
 * legal edge and the reactivate route would take it — but a button labelled
 * "Reactivate tenant" on a tenant that is running its trial describes something
 * that is not happening, and what it would actually do is end the trial early.
 * The three below are the ones the route's own comment names as what it exists
 * to restore from.
 */
const REACTIVATABLE_STATUSES: readonly TenantStatus[] = ['suspended', 'past_due', 'cancelled'];

/**
 * Which operator actions this state allows.
 *
 * Suspension is read from the contract's own transition table — the same object
 * the API's state machine throws against — so a console that offered a move the
 * graph forbids would be offering a button whose only outcome is a refusal, and
 * a new edge reaches this screen with no change here.
 *
 * An unknown status — an empty trail — allows neither. Offering `Suspend` on a
 * tenant whose state could not be read is the one guess this screen must not
 * make: it is immediate, platform-wide, and takes a customer's agents offline
 * mid-conversation.
 */
export interface TenantActionAvailability {
  readonly canSuspend: boolean;
  readonly canReactivate: boolean;
}

export function tenantActions(status: TenantStatus | null): TenantActionAvailability {
  if (status === null) {
    return { canSuspend: false, canReactivate: false };
  }

  return {
    canSuspend: TENANT_STATUS_TRANSITIONS[status].includes('suspended'),
    canReactivate: REACTIVATABLE_STATUSES.includes(status),
  };
}
