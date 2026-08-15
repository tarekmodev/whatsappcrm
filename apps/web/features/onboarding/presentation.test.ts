import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEP_IDS, ONBOARDING_STEP_STATUSES } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import {
  ONBOARDING_STATUS_TONES,
  ONBOARDING_STEP_DESTINATIONS,
  onboardingStepIntent,
} from './presentation';

describe('onboardingStepIntent', () => {
  it('offers a skip on a step that has not been done', () => {
    expect(onboardingStepIntent('pending')).toBe('skip');
  });

  it('offers the undo on a skipped step, which is what makes it returnable', () => {
    expect(onboardingStepIntent('skipped')).toBe('reopen');
  });

  it('offers neither on a completed step', () => {
    // Both the mock transport and the contract refuse skipping something already
    // done, so a control here would be one the API rejects.
    expect(onboardingStepIntent('completed')).toBeNull();
  });
});

describe('ONBOARDING_STEP_DESTINATIONS', () => {
  it('sends each step to the surface that already owns the job', () => {
    expect(ONBOARDING_STEP_DESTINATIONS.connect_whatsapp).toBe('/settings/whatsapp');
    expect(ONBOARDING_STEP_DESTINATIONS.invite_agents).toBe('/settings/people');
  });

  it('links branding nowhere until TAR-29 builds the editor', () => {
    // A link here would be a link to a 404. The step says so and offers the skip.
    expect(ONBOARDING_STEP_DESTINATIONS.set_branding).toBeNull();
  });
});

describe('the checklist’s copy and lookups', () => {
  it('covers every step the contract names', () => {
    for (const stepId of ONBOARDING_STEP_IDS) {
      expect(ONBOARDING_STEP_DESTINATIONS).toHaveProperty(stepId);
      expect(content.onboarding.steps[stepId].title.length).toBeGreaterThan(0);
    }
  });

  it('gives every status a tone, so none falls through to a default', () => {
    for (const status of ONBOARDING_STEP_STATUSES) {
      expect(ONBOARDING_STATUS_TONES[status]).toBeDefined();
      expect(content.onboarding.statuses[status].length).toBeGreaterThan(0);
    }
  });
});
