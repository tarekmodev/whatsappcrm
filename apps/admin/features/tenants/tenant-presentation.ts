import {
  TENANT_STATUS_TRANSITIONS,
  type AdminTenantLifecycleEvent,
  type TenantStatus,
} from '@whatsappcrm/contracts';
import type { BadgeTone } from '@/components/ui/Badge';

/**
 * How a tenant's lifecycle reads on the operator console: what state it is in,
 * how that state is drawn, and which writes it allows.
 *
 * One module, read from everywhere, the way `apps/web`'s `conversation-chips.ts`
 * is read — the spec (§2.4) asks for exactly that, and the reason is that a tone
 * inlined in a cell is a tone the next cell gets wrong.
 *
 * §2.4 also gives the status band a **second**, time-bounded chip — `Trial ends`,
 * `Grace period ends` or `Purges`, ranked in that order. The helper that picked it
 * lived here and has been removed: every one of those dates is on
 * `AdminTenantLifecycleResponse`, which is a *write* response, so nothing on a
 * freshly loaded screen could ever have supplied one. It returns with the tenant
 * read that supplies the dates.
 */

/**
 * Where the tenant is now, read off the newest row of its trail.
 *
 * **This is a derivation, not a read**, and it is here because the admin API
 * offers no other answer: there is no `GET /admin/tenants/{slug}`, and the routes
 * that *do* report a status are all writes. `…/lifecycle` returns the trail
 * newest first — `LifecycleEventsRepository` orders by `occurredAt desc, id desc`
 * — and every transition writes its row inside the transaction that makes it, so
 * there is no state the trail does not carry.
 *
 * **This is the seam that changes when a detail read lands** (spec §2.4): when
 * `GET /admin/tenants/{slug}` exists, this function is what it replaces.
 *
 * `null` for a tenant with no rows at all. That is a real case rather than a
 * fault — `lifecycle_events` was added after tenants existed — and inventing
 * `active` for it would be the console asserting something it does not know
 * about a tenant an operator is about to act on.
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
 * The status tone map, fixed by the spec (§2.4).
 *
 * Two of these are worth stating because they read as wrong at a glance and are
 * not:
 *
 *   * **`deleted` is `neutral`, not `danger`.** Danger marks a state that wants
 *     an operator's attention, and a purged tenant wants nothing.
 *   * **`created` is `neutral` too.** No tenant is ever *served* in it — both
 *     provisioning paths leave it inside the transaction that created the row —
 *     so seeing it is odd but not urgent.
 */
export function tenantStatusTone(status: TenantStatus): BadgeTone {
  switch (status) {
    case 'active':
      return 'success';
    case 'trialing':
      return 'info';
    case 'past_due':
      return 'warning';
    case 'suspended':
    case 'cancelled':
      return 'danger';
    case 'created':
    case 'deleted':
      return 'neutral';
  }
}

/**
 * The three states reactivation is *for*: the ones an operator or an automated
 * timer put a working tenant into.
 *
 * Narrower than the transition table, deliberately. `trialing → active` is a
 * legal edge and the route would take it — but a control labelled "Reactivate"
 * on a tenant running its trial describes something that is not happening, and
 * what it would actually do is end the trial early.
 */
const REACTIVATABLE: readonly TenantStatus[] = ['suspended', 'past_due', 'cancelled'];

/**
 * Which of the four per-tenant writes this state allows.
 *
 * Read from the contract's own transition table — the same object the API's state
 * machine throws against — so the console cannot offer a move the graph forbids,
 * and a new edge reaches this screen with no change here.
 *
 * A tenant in `deleted` allows nothing, and the menu is **omitted** rather than
 * disabled (spec §2.4): the graph has no edge out, so every entry would be a
 * control that exists only to refuse.
 *
 * An **unknown** status allows nothing either. Offering Suspend on a tenant whose
 * state could not be read is the one guess this screen must not make: it is
 * immediate, platform-wide, and takes a customer's agents offline mid-conversation.
 */
export interface TenantWrites {
  readonly canSuspend: boolean;
  readonly canReactivate: boolean;
  readonly canCancel: boolean;
  readonly canDelete: boolean;
  /** True when none of the four is available, so the caller omits the menu. */
  readonly isEmpty: boolean;
}

export function tenantWrites(status: TenantStatus | null): TenantWrites {
  if (status === null || status === 'deleted') {
    return {
      canSuspend: false,
      canReactivate: false,
      canCancel: false,
      canDelete: false,
      isEmpty: true,
    };
  }

  const reachable = TENANT_STATUS_TRANSITIONS[status];
  const canSuspend = reachable.includes('suspended');
  const canReactivate = REACTIVATABLE.includes(status);
  const canCancel = reachable.includes('cancelled');
  // Deletion is scheduled through `cancelled`, or forced through `suspended`.
  const canDelete = canCancel || canSuspend;

  return {
    canSuspend,
    canReactivate,
    canCancel,
    canDelete,
    isEmpty: !canSuspend && !canReactivate && !canCancel && !canDelete,
  };
}
