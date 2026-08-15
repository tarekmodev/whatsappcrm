import { FALLBACK_ASSIGNMENT_REASONS, type FallbackAssignmentReason } from '@whatsappcrm/contracts';
import type { FilterPillItem } from '@/components/ui/FilterPills';
import { routes } from '@/lib/routes';
import type { Content } from '@/lib/content';

/**
 * The flagged queue's one filter: which deferral reason to narrow to.
 *
 * It lives in the URL, so a supervisor can send "everyone is at capacity, look" as
 * a link and the back button behaves. Everything else about the query is fixed by
 * ADR 0008 — `routingState=deferred` is what "flagged" *means*, not a choice the
 * user makes.
 */

/** An unrecognised `?reason=` is dropped rather than rejected: the URL is untrusted. */
export function parseDeferredReason(
  value: string | undefined,
): FallbackAssignmentReason | undefined {
  return FALLBACK_ASSIGNMENT_REASONS.find((reason) => reason === value);
}

/**
 * The pill strip, with "All reasons" first so clearing the filter is always one
 * click away and never a matter of editing the address bar.
 */
export function deferredReasonFilters(
  content: Content,
  current: FallbackAssignmentReason | undefined,
): FilterPillItem[] {
  return [
    {
      id: 'all',
      label: content.assignment.reasonFilterAll,
      href: routes.settingsAssignment(),
      isCurrent: current === undefined,
    },
    ...FALLBACK_ASSIGNMENT_REASONS.map((reason) => ({
      id: reason,
      label: content.assignment.deferredReasons[reason],
      href: routes.settingsAssignment({ deferredReason: reason }),
      isCurrent: current === reason,
    })),
  ];
}
