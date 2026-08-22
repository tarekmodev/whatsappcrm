import type {
  BillingSummaryResponse,
  Money,
  PlanEntitlements,
  PlanLimits,
} from '@whatsappcrm/contracts';
import { readUsage, readThreshold, type UsageReading } from '@/lib/plan/usage-reading';
import type { CheckoutOutcome } from '@/lib/routes';

/**
 * The pure rules behind the billing surface, kept out of the components so they
 * can be tested on their own and so no second surface re-derives one of them
 * differently.
 *
 * Nothing here decides *whether a plan may be chosen* — `isSelectable` and
 * `blockedBy` arrive from the API, because they depend on live usage the console
 * does not hold. What is here is phrasing, formatting, and the one genuinely
 * console-side judgement: what the page may claim after a redirect back from a
 * hosted checkout page.
 */

/** Seats and conversations, read against whatever the tenant is entitled to. */
export interface PlanUsageReadings {
  readonly seats: UsageReading;
  readonly conversations: UsageReading;
}

export function readPlanUsage(
  usage: BillingSummaryResponse['usage'],
  limits: PlanLimits,
): PlanUsageReadings {
  return {
    // Pending invitations count against the cap, per ADR 0009 — a meter that
    // showed only accepted members would contradict the refusal an admin then
    // gets from the invite endpoint.
    seats: readUsage(usage.seatsUsed + usage.seatsPending, limits.seats),
    conversations: readUsage(usage.conversationsThisPeriod, limits.conversationsPerPeriod),
  };
}

/**
 * Formats a per-seat price from its minor-unit amount.
 *
 * The exponent is asked of `Intl` rather than assumed to be two. This product is
 * sold into the GCC, where KWD, BHD and OMR all carry **three** minor digits and
 * JPY carries none — dividing by a hard-coded 100 would price a Kuwaiti plan at
 * ten times its real value, in the one place on the site where a wrong number is
 * a wrong invoice.
 */
export function formatSeatPrice(price: Money, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: price.currency,
  });
  const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2;

  return formatter.format(price.amountMinor / 10 ** exponent);
}

/** Formats a count against a locale, so server and client agree on the separator. */
export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/**
 * What the page may say after the browser comes back from a hosted checkout.
 *
 * The rule this encodes is the one thing about this flow that is easy to get
 * wrong and expensive when wrong: **the redirect is not the confirmation.** The
 * provider sends the browser back the moment the payment is taken, and its
 * subscription webhook — the thing that actually moves our subscription row —
 * arrives separately and usually a little later. So there are three outcomes,
 * not two, and only `succeeded` is allowed to claim the plan has changed:
 *
 *   - **`cancelled`** — the user backed out. Nothing was charged.
 *   - **`succeeded`** — the subscription is active *and* on the plan the
 *     checkout was for. Both halves are required: without the plan check, an
 *     upgrade from one paid tier to another would report success against the
 *     tier the tenant was already on.
 *   - **`confirming`** — the browser is back and the subscription is not there
 *     yet. Says so plainly and offers a refresh, rather than either
 *     congratulating the user on a change the API has no evidence of or showing
 *     the old plan with no explanation.
 *
 * Returns `null` when the page was not reached from a checkout at all, so the
 * caller needs no conditional of its own.
 */
export type CheckoutReport =
  | { readonly kind: 'succeeded'; readonly planName: string }
  | { readonly kind: 'confirming' }
  | { readonly kind: 'cancelled' };

export function reportCheckout(
  outcome: CheckoutOutcome | undefined,
  planKey: string | undefined,
  summary: BillingSummaryResponse,
): CheckoutReport | null {
  if (outcome === undefined) {
    return null;
  }

  if (outcome === 'cancelled') {
    return { kind: 'cancelled' };
  }

  const { subscription, plan } = summary;
  const isActive = subscription !== null && subscription.status === 'active';
  // An absent `plan` parameter means an older link, or one somebody edited: fall
  // back to "is there an active subscription at all", which is weaker but never
  // claims more than it knows.
  const isTheRightPlan = planKey === undefined || subscription?.planKey === planKey;

  return isActive && isTheRightPlan && plan !== null
    ? { kind: 'succeeded', planName: plan.name }
    : { kind: 'confirming' };
}

/**
 * Whether the conversation allowance warrants a banner, and how loud.
 *
 * Read off the *conversation* meter only. Seats have their own refusal — the
 * invite endpoint says no, in the place where somebody is trying to add one — so
 * a second seat banner on a page they may not be on would be noise. A volume
 * allowance has no such moment: it is crossed by customers writing in, and
 * nobody finds out unless the console says so.
 */
export function readVolumeBanner(readings: PlanUsageReadings): 'approaching' | 'reached' | null {
  const threshold = readThreshold(readings.conversations);

  return threshold === 'under' ? null : threshold;
}

/**
 * The features a plan grants, in the catalogue's own order rather than the
 * plan's, so two cards compare row by row instead of shuffling.
 */
export function orderedFeatures(
  entitlements: PlanEntitlements,
  catalogue: readonly PlanEntitlements['features'][number][],
): readonly PlanEntitlements['features'][number][] {
  return catalogue.filter((feature) => entitlements.features.includes(feature));
}
