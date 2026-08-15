import type { TenantLifecycleResponse } from '@whatsappcrm/contracts';
import type { UsageMeterTone } from '@/components/ui/UsageMeter';

/**
 * Turns `TenantLifecycleResponse.usage` and the plan's limits into what the
 * meters render. Pure, and separate from the components, for the reason the
 * People and WhatsApp features keep their presentation maps out of theirs: the
 * rules are worth testing on their own, and a second surface that shows a
 * limit — the onboarding checklist, an inbox warning — must not re-derive them
 * differently.
 *
 * Three rules a reader cannot infer from the shape:
 *
 *   1. **`null` is unlimited**, per `PlanLimitsSchema` — deliberately not `-1`,
 *      and deliberately not treated as zero, which would render every unlimited
 *      plan as permanently over its cap.
 *   2. **Pending invitations count towards the seat cap.** ADR 0009 enforces
 *      the cap at invite *creation* as well as at acceptance, because counting
 *      only active users lets an admin mint unlimited invitations and blow past
 *      the cap the moment a mailout lands. A meter that showed only the active
 *      count would contradict the refusal the admin then gets.
 *   3. **A count may exceed its cap.** A plan downgraded below current usage is
 *      a real state, so `ratio` is not clamped here — `UsageMeter` clamps what
 *      it draws, and `isAtCap` stays true rather than flipping to false above
 *      the line.
 */

export interface UsageReading {
  /** What is consumed, including anything reserved but not yet taken up. */
  readonly used: number;
  /** `null` when the plan sets no limit. */
  readonly cap: number | null;
  /** Fraction consumed, or `undefined` when there is no cap to be a fraction of. */
  readonly ratio: number | undefined;
  readonly isAtCap: boolean;
  readonly tone: UsageMeterTone;
}

/**
 * Where the meter changes colour. `warning` is deliberately below the cap — the
 * point of the gauge is to be seen *before* the next invitation is refused.
 */
const WARNING_RATIO = 0.8;

export function readSeatUsage(lifecycle: TenantLifecycleResponse): UsageReading {
  const { seatsUsed, seatsPending } = lifecycle.usage;

  return read(seatsUsed + seatsPending, lifecycle.plan.entitlements.limits.seats);
}

export function readConversationUsage(lifecycle: TenantLifecycleResponse): UsageReading {
  return read(
    lifecycle.usage.conversationsThisPeriod,
    lifecycle.plan.entitlements.limits.conversationsPerPeriod,
  );
}

function read(used: number, cap: number | null): UsageReading {
  if (cap === null) {
    return { used, cap: null, ratio: undefined, isAtCap: false, tone: 'accent' };
  }

  // A cap of zero would divide by zero, and it means "none of this is
  // available" rather than "unlimited": full bar, at cap.
  const ratio = cap === 0 ? 1 : used / cap;

  return { used, cap, ratio, isAtCap: used >= cap, tone: toneFor(ratio) };
}

function toneFor(ratio: number): UsageMeterTone {
  if (ratio >= 1) {
    return 'danger';
  }

  return ratio >= WARNING_RATIO ? 'warning' : 'accent';
}
