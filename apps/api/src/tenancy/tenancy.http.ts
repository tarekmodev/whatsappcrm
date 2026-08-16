import { BRANDING_UPLOAD_FIELD } from '@whatsappcrm/contracts';
import { ApiException } from '../common/errors/api.exception';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { TenantNotFoundError } from './tenant-deactivation.errors';
import {
  BrandingAssetNotFoundError,
  BrandingAssetTooLargeError,
  BrandingAssetTypeUnsupportedError,
  BrandingAssetUnreadableError,
  BrandingFileMissingError,
  DomainNotActivatedError,
  DomainNotVerifiedError,
  DomainRoutingUnconfiguredError,
  DomainVerificationThrottledError,
  PlatformDomainNotRemovableError,
  ApexHostnameNotClaimableError,
  PlatformHostnameNotClaimableError,
  TenantDomainNotFoundError,
  TenantDomainTakenError,
  TooManyCustomDomainsError,
} from './tenancy.errors';

/**
 * The branding and custom-domain failures as the published error taxonomy states
 * them (`packages/contracts/src/error-codes.ts`).
 *
 * One table rather than a `catch` per handler, so the same condition cannot
 * answer 409 on one route and 403 on another. The mappings worth arguing about:
 *
 *   * **a hostname somebody else holds is `conflict`, not `forbidden`** —
 *     `forbidden` would confirm the hostname exists in another tenant, and the
 *     message deliberately names nothing about the holder;
 *   * **an unknown domain id is `not_found`**, for the same reason: absent and
 *     "present in another tenant" are indistinguishable by design (TAR-39);
 *   * **a hostname under `PLATFORM_DOMAIN` is `validation_failed`**, because it
 *     is a fact about the value the caller sent rather than about their
 *     authority — nobody may claim one, however privileged;
 *   * **the environment having no edge hostname is `feature_not_in_plan`**. It
 *     is the closest published code for "this deployment does not offer custom
 *     domains", and it is a 403 rather than a 500 because nothing is broken:
 *     TAR-419 has simply not been run here;
 *   * **bytes missing behind a row that names them is `internal_error`.** The
 *     database and the object store disagree, which is an operational fault and
 *     not the caller's problem.
 *
 * Anything not listed is not ours to interpret and is re-thrown, so it reaches
 * the global filter as the 500 a fault should be.
 */
export function translateTenancyFailure(error: unknown): never {
  if (error instanceof BrandingFileMissingError) {
    throw new ApiException('validation_failed', error.message, [
      { path: BRANDING_UPLOAD_FIELD, message: error.message },
    ]);
  }

  if (error instanceof BrandingAssetTypeUnsupportedError) {
    throw new ApiException('validation_failed', error.message, [
      { path: BRANDING_UPLOAD_FIELD, message: error.message },
    ]);
  }

  if (error instanceof BrandingAssetTooLargeError) {
    throw new ApiException('payload_too_large', error.message);
  }

  if (error instanceof BrandingAssetNotFoundError || error instanceof TenantDomainNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof TenantNotFoundError) {
    throw new ApiException('not_found', error.message);
  }

  if (error instanceof BrandingAssetUnreadableError) {
    throw new ApiException(
      'internal_error',
      'The stored image could not be read. This has been logged.',
    );
  }

  if (
    error instanceof PlatformHostnameNotClaimableError ||
    error instanceof ApexHostnameNotClaimableError
  ) {
    throw new ApiException('validation_failed', error.message, [
      { path: 'hostname', message: error.message },
    ]);
  }

  if (error instanceof TenantDomainTakenError) {
    throw new ApiException('conflict', error.message);
  }

  if (error instanceof DomainNotVerifiedError || error instanceof DomainNotActivatedError) {
    // Both are `conflict`: the request is well formed and the caller is
    // permitted, the resource is simply in a state that does not allow it yet.
    throw new ApiException('conflict', error.message);
  }

  if (error instanceof PlatformDomainNotRemovableError) {
    throw new ApiException('forbidden', error.message);
  }

  if (error instanceof TooManyCustomDomainsError) {
    throw new ApiException('plan_limit_exceeded', error.message);
  }

  if (error instanceof DomainRoutingUnconfiguredError) {
    throw new ApiException('feature_not_in_plan', error.message);
  }

  if (error instanceof DomainVerificationThrottledError) {
    throw new ApiException('rate_limited', error.message);
  }

  if (error instanceof TenantNotActiveError) {
    // A deactivated tenant with a session still open (TAR-51). A runtime state
    // an operator created, not a fault — reporting it as 500 would page someone
    // every time a tenant was shut off.
    throw new ApiException('forbidden', error.message);
  }

  throw error;
}
