import type { FallbackAssignmentReason } from '@whatsappcrm/contracts';
import type { BadgeTone } from '@/components/ui/Badge';

/**
 * Maps a deferral reason onto presentation, kept out of the components so the
 * table, the filter pills and any later alert label a reason identically — and so
 * a fourth reason means editing one table.
 */

/**
 * Tone is intent, never the whole message: the badge always carries the reason in
 * words beside it, because a supervisor with a forced-colors mode or a colour
 * vision difference still has to be able to tell a staffing gap from a misconfigured
 * team.
 *
 * `all_at_capacity` is `warning` rather than `danger` deliberately — it is the
 * state that resolves itself as tickets close. `no_candidate_pool` is `danger`
 * because nothing will ever fix it without somebody changing the configuration.
 */
export const DEFERRED_REASON_TONES: Record<FallbackAssignmentReason, BadgeTone> = {
  all_at_capacity: 'warning',
  none_available: 'danger',
  no_candidate_pool: 'danger',
};
