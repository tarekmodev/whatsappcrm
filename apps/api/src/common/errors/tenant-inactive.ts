import { TENANT_NOT_ACTIVE_ERROR, type TenantNotActiveError } from '../../prisma/prisma.errors';
import { ApiException } from './api.exception';

/**
 * The one answer a caller gets when the tenant in scope is not serviceable
 * (TAR-539).
 *
 * ## Why the message is fixed rather than the error's own
 *
 * `TenantNotActiveError.message` is written for an engineer reading a log: it
 * names `TenantPrisma`, `SystemPrisma`, the failing model and operation, and the
 * tenant's UUID. Every call site that translated it used to pass that string
 * straight into the response body, which handed an authenticated-but-locked-out
 * caller a description of the data layer and the tenant id behind it. Nothing in
 * it is actionable by the person reading it, and the state it reports — an
 * operator suspended this workspace — is fully described by one sentence.
 *
 * The engineer's version is not lost: `AllExceptionsFilter` logs the thrown
 * error under the same `requestId` the caller is shown.
 *
 * ## Why `subscription_inactive` rather than `forbidden`
 *
 * 0002 reserves pipeline stage 4 for `TenantStatusGuard` and states its answer
 * as `subscription_inactive`; ADR 0009 decision 2 repeats it for this error
 * specifically, and login has answered it since TAR-51. `forbidden` said the
 * same thing in a code a client cannot distinguish from "you lack this
 * permission" — a distinction the console needs, because one of the two is
 * fixed by paying and the other is not. Answering `subscription_inactive`
 * wherever the condition is raised is also what keeps the guard and this
 * fallback from disagreeing once stage 4 exists: the guard refuses at the edge,
 * this catches whatever reached the data layer first, and both say the same
 * thing.
 */
export const TENANT_INACTIVE_MESSAGE = 'This workspace is not active. Contact your administrator.';

/**
 * Matched on the `kind` discriminator rather than with `instanceof`, which is
 * what `prisma.errors.ts` published it for: a filter sees an error that may have
 * crossed a module boundary, and `instanceof` is the check that quietly stops
 * being true when two copies of the class exist.
 */
export function isTenantNotActiveError(error: unknown): error is TenantNotActiveError {
  return error instanceof Error && 'kind' in error && error.kind === TENANT_NOT_ACTIVE_ERROR;
}

/** The published refusal, with no internal detail in it. */
export function tenantInactive(): ApiException {
  return new ApiException('subscription_inactive', TENANT_INACTIVE_MESSAGE);
}
