import type { OnboardingStepId } from '@whatsappcrm/contracts';

/**
 * The two ways the onboarding checklist refuses a write, as typed domain errors
 * rather than `HttpException`s — the same split `tenant-lifecycle.errors.ts`
 * makes, and for the same reason: a service has no business choosing a status
 * code, and the reader behind these is also reachable from a fixture that has
 * no response to send.
 *
 * `onboarding.http.ts` is the one place they become status codes.
 */
export abstract class TenantOnboardingError extends Error {
  constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * `intent: 'skip'` on a step the tenant has already done (TAR-832, Interfaces).
 *
 * `conflict` rather than `validation_failed`: the body is well formed and the
 * caller is permitted; the workspace is simply in a state where putting the step
 * off is not a thing the checklist can express. Completion is derived, so the
 * only way to make this true again is to undo the underlying fact.
 *
 * The shipped console cannot reach it — `onboardingStepIntent()` offers no
 * control on a completed step — which makes a non-trivial rate of this the
 * signal that a UI regression has started offering one.
 */
export class OnboardingStepCompletedError extends TenantOnboardingError {
  constructor(readonly stepId: OnboardingStepId) {
    super(`The ${stepId} step is already completed, so it cannot be skipped.`);
  }
}

/**
 * The path named a step that is not a member of `ONBOARDING_STEP_IDS`.
 *
 * `not_found` rather than `validation_failed`, which is what a Zod pipe on a
 * path parameter would naturally produce (TAR-832, Divergence 2). The segment
 * names a resource, and every other resource route in this API answers 404 for
 * one that does not exist — the mock's answer is the binding one.
 *
 * The message names no value the caller sent: a 404 body is rendered straight
 * back to a browser, and echoing the path segment into it makes this route a
 * reflection point for nothing gained.
 */
export class OnboardingStepNotFoundError extends TenantOnboardingError {
  constructor() {
    super('There is no onboarding step by that name.');
  }
}
