import type { TenantLifecycleResponse } from '@whatsappcrm/contracts';
import { readUsage, type UsageReading } from '@/lib/plan/usage-reading';

/**
 * Turns `TenantLifecycleResponse.usage` and the plan's limits into what the
 * meters render. Pure, and separate from the components, for the reason the
 * People and WhatsApp features keep their presentation maps out of theirs: the
 * rules are worth testing on their own, and a second surface that shows a
 * limit — the billing page, the onboarding checklist — must not re-derive them
 * differently.
 *
 * The arithmetic itself moved to `lib/plan/usage-reading.ts` when the billing
 * surface needed the identical rules (TAR-37); what stays here is the one thing
 * that is genuinely this feature's — reading the two counts off the *lifecycle*
 * response, and in particular that **pending invitations count towards the seat
 * cap**. ADR 0009 enforces the cap at invite creation as well as at acceptance,
 * because counting only active users lets an admin mint unlimited invitations
 * and blow past the cap the moment a mailout lands. A meter that showed only the
 * active count would contradict the refusal the admin then gets.
 */

export type { UsageReading };

export function readSeatUsage(lifecycle: TenantLifecycleResponse): UsageReading {
  const { seatsUsed, seatsPending } = lifecycle.usage;

  return readUsage(seatsUsed + seatsPending, lifecycle.plan.entitlements.limits.seats);
}

export function readConversationUsage(lifecycle: TenantLifecycleResponse): UsageReading {
  return readUsage(
    lifecycle.usage.conversationsThisPeriod,
    lifecycle.plan.entitlements.limits.conversationsPerPeriod,
  );
}
