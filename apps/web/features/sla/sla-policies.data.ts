import 'server-only';

import type { SlaPolicyResponse } from '@whatsappcrm/contracts';
import { listSlaPolicies } from '@/lib/api/sla';
import { SLA_POLICIES_PAGE_SIZE } from './constants';

/**
 * The tenant's SLA configuration, split into the row the settings screen edits
 * and the rows it only reports.
 *
 * ## Why the split happens here rather than in the component
 *
 * `GET /sla-policies` answers one flat list, and which row a supervisor is
 * looking for is a rule rather than a position: the **catch-all** is the one
 * with `priority: null`, and it is what every ticket falls back to. Deciding
 * that once, on the server, is what stops the form and the overrides list
 * disagreeing about which policy is "the workspace default".
 *
 * ## `defaultPolicy` can be null, and that is a real state
 *
 * Provisioning seeds one catch-all per tenant and `SlaPolicyService.createDefault`
 * adds one lazily on the first evaluation that finds none — but both are guarded
 * on "the tenant has no policy at all", so a tenant whose only rows are
 * per-priority ones legitimately has no catch-all. The screen says so rather
 * than crashing or inventing a row it would then try to PATCH.
 */

export interface SlaPoliciesData {
  /** The `priority: null` row every ticket falls back to, or `null` if there is none. */
  readonly defaultPolicy: SlaPolicyResponse | null;
  /** Every other policy, oldest first, exactly as the API ordered them. */
  readonly overrides: readonly SlaPolicyResponse[];
  /**
   * True when the tenant has more policies than one page holds. The overrides
   * section says so instead of quietly showing a truncated list — a supervisor
   * reading "these are all of them" when they are not is worse than no list.
   */
  readonly hasMore: boolean;
}

export async function loadSlaPolicies(): Promise<SlaPoliciesData> {
  const page = await listSlaPolicies({ limit: SLA_POLICIES_PAGE_SIZE });

  return {
    defaultPolicy: page.items.find((policy) => policy.priority === null) ?? null,
    overrides: page.items.filter((policy) => policy.priority !== null),
    hasMore: page.nextCursor !== null,
  };
}
