import 'server-only';

import {
  OnboardingChecklistResponseSchema,
  type OnboardingChecklistResponse,
  type OnboardingStepId,
  type OnboardingStepIntent,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * The onboarding checklist endpoints from `contracts/onboarding.ts`.
 *
 * Both go through `authenticatedRequest`, so the tenant they answer for is the
 * one the session cookie resolves to — never an id this process could pass. The
 * response is validated against the contract here and in exactly one place, which
 * is what makes swapping the mock transport for TAR-405's real endpoints a
 * configuration change rather than a component one.
 */

const ONBOARDING_PATH = '/v1/tenant/onboarding';

export async function getOnboardingChecklist(): Promise<OnboardingChecklistResponse> {
  return OnboardingChecklistResponseSchema.parse(
    await authenticatedRequest({ method: 'GET', path: ONBOARDING_PATH }),
  );
}

/**
 * Skips a step, or puts a skipped one back. Answers with the whole checklist
 * rather than the one step, so a caller cannot render a progress meter derived
 * from a checklist it has only half of.
 */
export async function updateOnboardingStep(
  stepId: OnboardingStepId,
  intent: OnboardingStepIntent,
): Promise<OnboardingChecklistResponse> {
  return OnboardingChecklistResponseSchema.parse(
    await authenticatedRequest({
      method: 'PATCH',
      // `stepId` is a contract enum member, not free text, so there is nothing
      // here to encode — and a value that is not one never reaches this call.
      path: `${ONBOARDING_PATH}/steps/${stepId}`,
      body: { intent },
    }),
  );
}
