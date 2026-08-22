import type { ConfigService } from '@nestjs/config';
import type { VolumePolicy } from '@whatsappcrm/contracts';

/**
 * A `ConfigService` carrying nothing but `BILLING_VOLUME_POLICY`, for the tests
 * that construct `PlanLimitsService` directly.
 *
 * It defaults to **`block`**, which is deliberately *not* the production
 * default. Every existing test of the conversation cap was written before the
 * policy existed, when refusing at the ceiling was the only behaviour — so this
 * keeps them asserting what they were written to assert, and makes the tests
 * that cover `warn` say so explicitly at the construction site rather than by
 * inheriting a default.
 *
 * A cast stub rather than a real `ConfigService`: it is the pattern the rest of
 * the suite already uses (`bot-eligibility.spec.ts`, `bootstrap.spec.ts`), and a
 * real one would need the whole validated environment to answer one key.
 */
export function volumePolicyConfig(policy: VolumePolicy = 'block'): ConfigService {
  return { getOrThrow: () => policy } as unknown as ConfigService;
}
