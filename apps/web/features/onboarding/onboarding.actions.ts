'use server';

import {
  OnboardingStepRequestSchema,
  type OnboardingChecklistResponse,
} from '@whatsappcrm/contracts';
import { updateOnboardingStep } from '@/lib/api/onboarding';
import { runAction } from '@/lib/actions/run-action';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';

/**
 * Skipping an onboarding step, and putting a skipped one back.
 *
 * One action for both, because they are one write with two values and splitting
 * them would duplicate the assert-validate-revalidate sequence for no gain. The
 * step id is validated here rather than trusted: a server action is a public
 * endpoint, and the button that sent it is not the security boundary.
 *
 * There is deliberately no "mark done" counterpart. Completion is derived by the
 * API from the tenant's actual state — a connected number, an invitation sent —
 * so the console has nothing to assert. See `contracts/onboarding.ts`.
 *
 * It revalidates the checklist path, so the server re-renders the list, the
 * progress meter and which step is open from one source rather than from an
 * optimistic copy the client would then have to roll back.
 */
export async function setOnboardingStepIntentAction(
  input: unknown,
): Promise<ActionResult<OnboardingChecklistResponse>> {
  return runAction({
    permission: 'tenant:settings',
    parser: OnboardingStepRequestSchema,
    input,
    perform: ({ stepId, intent }) => updateOnboardingStep(stepId, intent),
    revalidate: routes.onboarding(),
    label: 'Onboarding step',
  });
}
