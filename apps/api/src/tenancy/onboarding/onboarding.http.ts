import { ApiException } from '../../common/errors/api.exception';
import { isTenantNotActiveError, tenantInactive } from '../../common/errors/tenant-inactive';
import { TenantNotFoundError } from '../tenant-deactivation.errors';
import {
  OnboardingStepCompletedError,
  OnboardingStepNotFoundError,
} from './tenant-onboarding.errors';

/**
 * The onboarding failures as the published error taxonomy states them
 * (`packages/contracts/src/error-codes.ts`), in the table TAR-832 fixes.
 *
 * One translator rather than a `catch` per handler, so the same condition cannot
 * answer 409 on one route and 400 on another. The two mappings worth arguing
 * about are argued in `tenant-onboarding.errors.ts`, beside the errors
 * themselves.
 *
 * `TenantNotFoundError` is reachable here only as a backstop: `HostTenantGuard`
 * has already resolved the tenant by the time a handler runs, so a tenant that
 * vanished between the guard and the read is the only path to it.
 *
 * Anything not listed is not ours to interpret and is re-thrown, so it reaches
 * the global filter as the 500 a fault should be.
 */
export function translateOnboardingFailure(error: unknown): never {
  if (error instanceof OnboardingStepCompletedError) {
    throw new ApiException('conflict', error.message);
  }

  if (error instanceof OnboardingStepNotFoundError || error instanceof TenantNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (isTenantNotActiveError(error)) {
    // The database gate refused. These routes are deliberately **off** the
    // `@AvailableWhileSuspended()` allowlist, so a suspended tenant's admin
    // reaches this rather than the checklist — onboarding is not what the
    // recovery allowlist exists for.
    //
    // `tenantInactive()` rather than a message of our own (TAR-539):
    // `TenantNotActiveError.message` names `TenantPrisma`, the failing model and
    // the tenant's UUID, and a 402 is not redacted in production the way a 500
    // is.
    throw tenantInactive();
  }

  throw error;
}
