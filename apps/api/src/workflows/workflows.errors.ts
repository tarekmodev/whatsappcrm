import { WORKFLOW_LIMITS, type WorkflowReferenceUse } from '@whatsappcrm/contracts';

/**
 * Typed failures the workflow services raise, mapped to error codes in
 * `workflows.http.ts`.
 *
 * Domain errors rather than `ApiException`s from the service layer, on
 * `assignment.errors.ts`' reasoning: the workflow service is driven by the
 * engine's tests and by fixtures as well as by HTTP, and neither of those has a
 * response to put a status on.
 */

export class WorkflowNotFoundError extends Error {
  constructor(readonly workflowId: string) {
    super(`No workflow ${workflowId} in this tenant.`);
    this.name = 'WorkflowNotFoundError';
  }
}

export class WorkflowNameTakenError extends Error {
  constructor(readonly workflowName: string) {
    // `citext`, so `Escalate` collides with `escalate` — worth saying, because
    // "Escalate already exists" is confusing when you typed "escalate".
    super(
      `A workflow named ${workflowName} already exists in this tenant. Workflow names are ` +
        'case-insensitive.',
    );
    this.name = 'WorkflowNameTakenError';
  }
}

/**
 * The cap on workflows per tenant, reached on create.
 *
 * `conflict`, not `plan_limit_exceeded` (0009, limits): the cap is a property of
 * the engine — one triggering occurrence costs `workflows × conditions` — not of
 * the tenant's plan, and answering `402` would send a supervisor to the billing
 * page to fix something money cannot.
 */
export class TooManyWorkflowsError extends Error {
  constructor() {
    super(
      `This tenant already has ${WORKFLOW_LIMITS.workflowsPerTenant} workflows, which is the ` +
        'maximum. Delete or merge one before adding another.',
    );
    this.name = 'TooManyWorkflowsError';
  }
}

/**
 * The separate, lower cap on workflows carrying `ticket_unresolved_for`.
 *
 * Lower than `workflowsPerTenant` because each one is a threshold the sweep has
 * to consider on every tick, unlike an event trigger which costs nothing until
 * it fires.
 */
export class TooManyElapsedTriggerWorkflowsError extends Error {
  constructor() {
    super(
      `This tenant already has ${WORKFLOW_LIMITS.elapsedTriggerWorkflowsPerTenant} workflows ` +
        'with an elapsed trigger, which is the maximum. Each one is work the sweep does every ' +
        'minute. Delete or merge one before adding another.',
    );
    this.name = 'TooManyElapsedTriggerWorkflowsError';
  }
}

/**
 * A `tagId`, `teamId` or `userId` naming something that is not in this tenant,
 * on a request that is otherwise well-formed.
 *
 * `validation_failed` naming the field, never `not_found` (0009, REST surface):
 * row-level security means another tenant's team is simply not visible, so the
 * server genuinely cannot tell it from a team that never existed — and that
 * indistinguishability is the point. The refusal says which field is wrong,
 * which is what the console needs, and confirms nothing.
 */
export class UnknownWorkflowReferenceError extends Error {
  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(`${value} is not in this tenant.`);
    this.name = 'UnknownWorkflowReferenceError';
  }
}

/**
 * `isActive: true` on a workflow whose references do not all resolve — either
 * because `brokenReason` is already set, or because one of the ids in the
 * definition names a row that has since gone.
 *
 * **The one new error code this story adds.** Distinct from `validation_failed`
 * because the body is well-formed and the caller changed nothing: what is wrong
 * is a reference that was valid when the workflow was written. The console's
 * next action differs too — "pick a replacement", not "fix your input".
 */
export class WorkflowReferenceBrokenError extends Error {
  constructor(readonly broken: readonly WorkflowReferenceUse[]) {
    super(
      broken.length === 0
        ? 'This workflow was disabled because something it names was removed. Point it at a ' +
            'replacement before enabling it.'
        : `This workflow names ${broken.length} ${broken.length === 1 ? 'thing' : 'things'} that ` +
            'no longer exist. Point it at a replacement before enabling it.',
    );
    this.name = 'WorkflowReferenceBrokenError';
  }
}

/**
 * `reorder` was given something other than the tenant's current workflow set.
 *
 * `workflowIds` is the whole set rather than a delta, which buys optimistic
 * concurrency for free: a set that does not match exactly means somebody else
 * created or deleted a workflow since this client loaded the page, and the
 * honest answer is `conflict` rather than a silent partial reorder.
 */
export class WorkflowSetChangedError extends Error {
  constructor() {
    super(
      'The workflow list changed since you loaded it — somebody added or removed one. Reload ' +
        'and reorder again.',
    );
    this.name = 'WorkflowSetChangedError';
  }
}

/**
 * A stored `definition` that no longer parses against the published grammar.
 *
 * Unreachable through the API, which is the only writer and validates on the way
 * in; it would take a hand-edited row or a grammar change that removed a
 * condition type. Raised rather than swallowed on the **read** path, because
 * corrupt automation configuration is something the supervisor has to be told
 * about — the *evaluator* makes the opposite choice deliberately and skips the
 * workflow, because there its job is to not write to a live ticket on a
 * definition it cannot read.
 */
export class MalformedWorkflowDefinitionError extends Error {
  constructor(
    readonly workflowId: string,
    readonly detail: string,
  ) {
    super(`Workflow ${workflowId} has a definition that does not parse: ${detail}`);
    this.name = 'MalformedWorkflowDefinitionError';
  }
}

/**
 * The dry run named a ticket that is not visible to the caller.
 *
 * `not_found`, never `forbidden` — a 403 would confirm the id names a real
 * ticket. 0009 requires the dry run to check `ticket:read_all` **on the named
 * ticket** rather than assume `workflow:write` implies it, because the
 * permission table is data and could change underneath that assumption.
 */
export class WorkflowTestTicketNotFoundError extends Error {
  constructor(readonly ticketId: string) {
    super(`No ticket ${ticketId} is visible to you in this tenant.`);
    this.name = 'WorkflowTestTicketNotFoundError';
  }
}

export class InvalidWorkflowCursorError extends Error {
  constructor(readonly field: string) {
    super('That cursor was not minted by this list.');
    this.name = 'InvalidWorkflowCursorError';
  }
}

/**
 * The evaluation job named a ticket that is not visible in this tenant scope.
 *
 * Retryable, and the realistic cause is benign: the job overtook the transaction
 * that created its ticket. A forged or stale payload naming another tenant's
 * ticket reads nothing under RLS and arrives here too, and failing loudly is the
 * right answer for both — with one exception the handler makes, which is a run
 * that has already been claimed. There the ticket is recorded as `ticket_gone`
 * rather than retried, because the claim cannot be re-taken.
 */
export class WorkflowTicketNotVisibleError extends Error {
  constructor(readonly ticketId: string) {
    super(`Ticket ${ticketId} is not visible in this tenant scope.`);
    this.name = 'WorkflowTicketNotVisibleError';
  }
}
