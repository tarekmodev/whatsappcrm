import { ApiException } from '../../common/errors/api.exception';
import { isTenantNotActiveError, tenantInactive } from '../../common/errors/tenant-inactive';
import { TenantNotFoundError } from '../tenant-deactivation.errors';
import {
  InvalidLifecycleCursorError,
  InvalidTenantTransitionError,
  LifecycleEventNotFoundError,
  TenantSlugConfirmationError,
} from './tenant-lifecycle.errors';

/**
 * The lifecycle failures as the published error taxonomy states them
 * (`packages/contracts/src/error-codes.ts`).
 *
 * One table rather than a `catch` per handler, so the same condition cannot
 * answer 409 on one route and 403 on another. The mappings worth arguing about:
 *
 *   * **an illegal transition is `conflict`.** The request is well formed and
 *     the caller is permitted; the tenant is simply in a state that does not
 *     allow it — an admin pressing "undo" eight days after cancelling, or two
 *     browser tabs racing the same button. `validation_failed` would blame the
 *     body, which is correct in neither case.
 *   * **a mistyped `confirmSlug` is `validation_failed`, with a path.** It is a
 *     fact about the value sent, and naming the field is what lets the console
 *     put the message under the input rather than in a toast.
 *   * **an unknown tenant is `not_found`.** Reachable only through the operator
 *     routes, where a mistyped slug during an incident has to be told apart from
 *     a tenant that really was stopped.
 *
 * Anything not listed is not ours to interpret and is re-thrown, so it reaches
 * the global filter as the 500 a fault should be.
 */
export function translateLifecycleFailure(error: unknown): never {
  if (error instanceof InvalidTenantTransitionError) {
    throw new ApiException('conflict', error.message);
  }

  if (error instanceof TenantSlugConfirmationError) {
    throw new ApiException('validation_failed', error.message, [
      { path: 'confirmSlug', message: error.message },
    ]);
  }

  if (error instanceof InvalidLifecycleCursorError) {
    throw new ApiException('validation_failed', error.message, [
      { path: 'cursor', message: error.message },
    ]);
  }

  if (error instanceof TenantNotFoundError || error instanceof LifecycleEventNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (isTenantNotActiveError(error)) {
    // The database gate refused. Reachable on the tenant routes for a `created`
    // or `deleted` tenant only, both of which `HostTenantGuard` already answers
    // `tenant_not_found` for — so this is the backstop rather than the path.
    //
    // `tenantInactive()` rather than a message of our own (TAR-539):
    // `TenantNotActiveError.message` names `TenantPrisma`, the failing model and
    // the tenant's UUID, and a 402 is not redacted in production the way a 500
    // is. That helper is the one answer eleven translators now give.
    throw tenantInactive();
  }

  throw error;
}
