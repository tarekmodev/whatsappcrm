import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_STEP_IDS,
  OnboardingChecklistResponseSchema,
  OnboardingStepUpdateInputSchema,
  nextOnboardingStep,
  onboardingProgress,
  orderedOnboardingSteps,
  type OnboardingChecklistResponse,
  type OnboardingStep,
  type OnboardingStepStatus,
} from './onboarding';

/**
 * The checklist derivations the console renders straight into a progress meter,
 * pinned where getting them wrong is silent — a meter that never fills, or a
 * flow that keeps re-offering a step the admin already turned down.
 */

const TENANT_ID = '0192f000-0000-7000-8000-00000000a001';
const AT = '2026-08-15T09:00:00.000Z';

function checklist(...statuses: readonly OnboardingStepStatus[]): OnboardingChecklistResponse {
  const steps: OnboardingStep[] = ONBOARDING_STEP_IDS.map((id, index) => {
    const status = statuses[index] ?? 'pending';

    return {
      id,
      status,
      completedAt: status === 'completed' ? AT : null,
      skippedAt: status === 'skipped' ? AT : null,
    };
  });

  return { tenantId: TENANT_ID, steps, completedAt: null, updatedAt: AT };
}

describe('onboardingProgress', () => {
  it('counts a skipped step as resolved but not as completed', () => {
    expect(onboardingProgress(checklist('completed', 'skipped', 'pending'))).toEqual({
      completed: 1,
      skipped: 1,
      resolved: 2,
      total: 3,
      isComplete: false,
    });
  });

  it('is complete once nothing is pending, even if everything was skipped', () => {
    // The meter has to be able to reach the end: a bar that cannot fill reads as
    // an outstanding task rather than as a decision the admin already made.
    expect(onboardingProgress(checklist('skipped', 'skipped', 'skipped')).isComplete).toBe(true);
  });

  it('starts empty', () => {
    expect(onboardingProgress(checklist()).resolved).toBe(0);
  });
});

describe('nextOnboardingStep', () => {
  it('opens on the first pending step', () => {
    expect(nextOnboardingStep(checklist('completed', 'pending', 'pending'))).toBe('invite_agents');
  });

  it('passes over a skipped step rather than re-offering it', () => {
    expect(nextOnboardingStep(checklist('skipped', 'skipped', 'pending'))).toBe('set_branding');
  });

  it('is null once nothing is pending', () => {
    expect(nextOnboardingStep(checklist('completed', 'skipped', 'completed'))).toBeNull();
  });
});

describe('orderedOnboardingSteps', () => {
  it('reads in the canonical order whatever order the payload used', () => {
    const scrambled = checklist();

    expect(
      orderedOnboardingSteps({ ...scrambled, steps: [...scrambled.steps].reverse() }).map(
        (step) => step.id,
      ),
    ).toEqual([...ONBOARDING_STEP_IDS]);
  });
});

describe('OnboardingChecklistResponseSchema', () => {
  it('accepts a full checklist', () => {
    expect(OnboardingChecklistResponseSchema.safeParse(checklist()).success).toBe(true);
  });

  it('refuses a payload missing a step, so no client has to guess at a gap', () => {
    const partial = checklist();

    expect(
      OnboardingChecklistResponseSchema.safeParse({ ...partial, steps: partial.steps.slice(1) })
        .success,
    ).toBe(false);
  });
});

describe('OnboardingStepUpdateInputSchema', () => {
  it('accepts the two intents a client owns', () => {
    expect(OnboardingStepUpdateInputSchema.safeParse({ intent: 'skip' }).success).toBe(true);
    expect(OnboardingStepUpdateInputSchema.safeParse({ intent: 'reopen' }).success).toBe(true);
  });

  it('refuses a status write, because completion is the server’s to derive', () => {
    expect(OnboardingStepUpdateInputSchema.safeParse({ intent: 'completed' }).success).toBe(false);
  });
});
