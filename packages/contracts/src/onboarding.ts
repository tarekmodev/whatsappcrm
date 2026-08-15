import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/**
 * The guided onboarding checklist a new tenant admin lands in after signup
 * (TAR-36, TAR-407).
 *
 * **This file is the checklist's contract, and nothing more.**
 * [ADR 0009](../../../docs/architecture/0009-tenant-lifecycle-and-self-signup.md)
 * owns the tenant lifecycle, signup, provisioning, retention and the notification
 * hooks, and lists "the onboarding checklist's own state" among its non-goals:
 * TAR-407 owns the checklist, its steps and its persistence, and 0009 defines only
 * the lifecycle state the checklist runs inside. So the split here is the one that
 * document asks for — this reuses `tenant.ts`'s lifecycle vocabulary and adds
 * nothing to it.
 *
 * The routes below sit alongside 0009's tenant surface (`/v1/tenant/lifecycle`,
 * `/v1/tenant/cancel`) and are gated on the same `tenant:settings` permission it
 * assigns to a tenant-settings read.
 *
 * ## The one decision worth stating
 *
 * **Completion is server-derived; only skipping belongs to the client.** A step
 * is `completed` because the tenant actually has a connected WhatsApp Business
 * Account, an invited agent, or edited branding — never because somebody ticked
 * a box. That is why the write endpoint takes an *intent* (`skip` / `reopen`)
 * rather than a status: a client that could PATCH `completed` would let an admin
 * mark a workspace set up that has no number attached to it, and the checklist
 * would then be decoration rather than a description of the workspace.
 *
 * The consequence is that "skip" is not "done": a skipped step stays skipped and
 * reopenable, and `onboardingProgress` counts the two separately.
 */

/**
 * The three steps TAR-36's acceptance criteria name, in the order the console
 * walks an admin through them. Connecting a number comes first because the other
 * two are worth nothing without it — an invited agent has no inbox to work and
 * branding has no messages to brand.
 */
export const ONBOARDING_STEP_IDS = ['connect_whatsapp', 'invite_agents', 'set_branding'] as const;

export const OnboardingStepIdSchema = z.enum(ONBOARDING_STEP_IDS);
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/**
 * `skipped` is a first-class state rather than the absence of `completed`,
 * because TAR-36 requires a skipped step to be returnable — which needs the
 * checklist to remember that it was skipped rather than never started.
 */
export const ONBOARDING_STEP_STATUSES = ['pending', 'completed', 'skipped'] as const;

export const OnboardingStepStatusSchema = z.enum(ONBOARDING_STEP_STATUSES);
export type OnboardingStepStatus = (typeof ONBOARDING_STEP_STATUSES)[number];

export const OnboardingStepSchema = z.object({
  id: OnboardingStepIdSchema,
  status: OnboardingStepStatusSchema,
  /** Set only while `status` is `completed`; cleared if the underlying fact goes away. */
  completedAt: TimestampSchema.nullable(),
  /** Set only while `status` is `skipped`, so "when did I put this off" is answerable. */
  skippedAt: TimestampSchema.nullable(),
});

/**
 * The whole checklist, always with every step present. A step the tenant has not
 * reached is `pending` rather than absent: a client that had to distinguish
 * "missing" from "not started" would grow a second empty state for no gain.
 */
export const OnboardingChecklistResponseSchema = z.object({
  tenantId: IdSchema,
  steps: z.array(OnboardingStepSchema).length(ONBOARDING_STEP_IDS.length),
  /**
   * When every step was first resolved — completed or skipped. Null while any
   * step is still pending. Distinct from "all completed": an admin who skips
   * branding has finished onboarding, and being asked about it forever is how a
   * checklist becomes something people learn to ignore.
   */
  completedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
});

/**
 * `PATCH /api/v1/tenant/onboarding/steps/{stepId}`.
 *
 * An intent rather than a status — see the note at the top of this file. The
 * server refuses `skip` on a step it already knows to be `completed`, because
 * putting off something that is already done is not a state the checklist can be
 * in.
 */
export const ONBOARDING_STEP_INTENTS = ['skip', 'reopen'] as const;

export const OnboardingStepUpdateInputSchema = z.object({
  intent: z.enum(ONBOARDING_STEP_INTENTS),
});

/**
 * The path parameter and the body together.
 *
 * The API validates the two separately, as it does for every route. This exists
 * for a caller that is not an HTTP client — a Next server action is itself a
 * public endpoint, and receives the step id and the intent as one untrusted
 * object — so that it validates both against the contract rather than trusting
 * the id because the button that sent it looked right.
 */
export const OnboardingStepRequestSchema = OnboardingStepUpdateInputSchema.extend({
  stepId: OnboardingStepIdSchema,
});

export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;
export type OnboardingStepRequest = z.infer<typeof OnboardingStepRequestSchema>;
export type OnboardingChecklistResponse = z.infer<typeof OnboardingChecklistResponseSchema>;
export type OnboardingStepIntent = (typeof ONBOARDING_STEP_INTENTS)[number];
export type OnboardingStepUpdateInput = z.infer<typeof OnboardingStepUpdateInputSchema>;

/**
 * One step by id, in `ONBOARDING_STEP_IDS` order regardless of the order the API
 * happened to serialise them in. Returns `undefined` only for a payload that
 * failed its own schema, which `.parse` has already rejected before any caller
 * gets here.
 */
export function onboardingStep(
  checklist: OnboardingChecklistResponse,
  id: OnboardingStepId,
): OnboardingStep | undefined {
  return checklist.steps.find((step) => step.id === id);
}

/** Steps in the canonical order, whatever order the payload listed them in. */
export function orderedOnboardingSteps(
  checklist: OnboardingChecklistResponse,
): readonly OnboardingStep[] {
  return ONBOARDING_STEP_IDS.map((id) => onboardingStep(checklist, id)).filter(
    (step): step is OnboardingStep => step !== undefined,
  );
}

/** Resolved means the admin has dealt with it — done it, or deliberately put it off. */
export function isOnboardingStepResolved(step: OnboardingStep): boolean {
  return step.status !== 'pending';
}

export interface OnboardingProgress {
  readonly completed: number;
  readonly skipped: number;
  /** Completed plus skipped — what the meter fills to. */
  readonly resolved: number;
  readonly total: number;
  readonly isComplete: boolean;
}

/**
 * What the progress meter shows. `resolved` rather than `completed` fills the
 * bar, so an admin who has genuinely finished with the checklist sees a full one
 * — the alternative is a meter that can never reach the end, which reads as an
 * outstanding task rather than as a decision they already made.
 */
export function onboardingProgress(checklist: OnboardingChecklistResponse): OnboardingProgress {
  const steps = orderedOnboardingSteps(checklist);
  const completed = steps.filter((step) => step.status === 'completed').length;
  const skipped = steps.filter((step) => step.status === 'skipped').length;

  return {
    completed,
    skipped,
    resolved: completed + skipped,
    total: steps.length,
    isComplete: completed + skipped === steps.length,
  };
}

/**
 * The step the console opens on when the URL names none: the first one still
 * pending, or `null` once nothing is.
 *
 * Skipped steps are passed over rather than re-offered — the admin has already
 * answered that question, and re-asking on every visit is what makes a checklist
 * something people close.
 */
export function nextOnboardingStep(
  checklist: OnboardingChecklistResponse,
): OnboardingStepId | null {
  return orderedOnboardingSteps(checklist).find((step) => step.status === 'pending')?.id ?? null;
}
