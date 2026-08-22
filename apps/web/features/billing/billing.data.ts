import 'server-only';

import type { BillingSummaryResponse, PlanListResponse } from '@whatsappcrm/contracts';
import { getBillingPlans, getBillingSummary } from '@/lib/api/billing';

/**
 * Server-side reads for the billing surface.
 *
 * Two calls, in parallel, and deliberately not one: `GET /billing/subscription`
 * answers "what am I on and what have I used", `GET /billing/plans` answers
 * "what else is there". They are separate routes in the contract because a
 * console that only wants to show a usage meter — the workspace page, the
 * onboarding checklist — has no business fetching the whole catalogue.
 *
 * `GET /billing/usage` is deliberately **not** read here. Its counters cover
 * five metrics, only two of which this page meters, and the two it does meter
 * arrive on the summary already. Fetching it as well would be a third round-trip
 * to render numbers the page is holding — it belongs to a usage breakdown, which
 * is not what TAR-619 asks for.
 */

export interface BillingData {
  readonly summary: BillingSummaryResponse;
  readonly plans: PlanListResponse;
}

export async function loadBilling(): Promise<BillingData> {
  // Independent requests: awaiting them in sequence would double the section's
  // time to first byte for no reason.
  const [summary, plans] = await Promise.all([getBillingSummary(), getBillingPlans()]);

  return { summary, plans };
}
