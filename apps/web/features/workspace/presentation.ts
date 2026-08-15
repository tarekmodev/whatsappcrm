import type { TenantStatus } from '@whatsappcrm/contracts';
import type { BadgeTone } from '@/components/ui/Badge';

/**
 * Lifecycle state mapped onto presentation, on the same pattern the People and
 * WhatsApp features use: kept out of the components so every surface labels a
 * state identically, and so a new state means editing one table.
 *
 * Tone never carries the meaning on its own — the badge always shows the label
 * from the content layer beside it, and the plan panel repeats the description
 * underneath.
 */
export const TENANT_STATUS_TONES: Record<TenantStatus, BadgeTone> = {
  trialing: 'info',
  active: 'success',
  past_due: 'warning',
  suspended: 'danger',
  // Not `danger`: a closing workspace is still fully working, and colouring it
  // the same as a suspended one would make the two indistinguishable at a
  // glance when the difference is whether anybody can sign in.
  cancelled: 'warning',
  deleted: 'neutral',
};

/**
 * The states that get a banner above the page, and nothing else does. Absent
 * here means the state is unremarkable enough for the badge alone.
 *
 * `deleted` is deliberately absent: a deleted workspace has no console to show
 * a banner in — its principals cannot authenticate — so a branch for it would be
 * dead code pretending to handle a case it cannot reach.
 */
export const BANNER_STATUSES = ['past_due', 'suspended', 'cancelled'] as const;

export type BannerStatus = (typeof BANNER_STATUSES)[number];

export function isBannerStatus(status: TenantStatus): status is BannerStatus {
  return (BANNER_STATUSES as readonly TenantStatus[]).includes(status);
}
