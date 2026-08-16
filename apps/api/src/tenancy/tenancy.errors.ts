/**
 * The failures the tenant-facing branding and custom-domain surface produces, as
 * typed domain errors rather than `HttpException`s — the same split
 * `people.errors.ts` and `entitlements.errors.ts` make, and for the same reason:
 * a service has no business choosing a status code.
 *
 * `tenancy.errors.ts` rather than one file per feature because branding and
 * domains are one bounded context with one controller pair, and the translation
 * table a reviewer has to read is more useful in one piece.
 */

/** Base class, so a controller can tell "ours" from a fault in one check. */
export abstract class TenancyError extends Error {
  constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/** The tenant has never uploaded this asset. Rendered as `not_found`. */
export class BrandingAssetNotFoundError extends TenancyError {
  constructor(readonly kind: string) {
    super(`This workspace has no ${kind}.`);
  }
}

/** The multipart body carried no file part at all. */
export class BrandingFileMissingError extends TenancyError {
  constructor(readonly fieldName: string) {
    super(`The upload must carry a file in the "${fieldName}" field.`);
  }
}

/** Past the per-asset ceiling in `BRANDING_ASSET_LIMITS`. */
export class BrandingAssetTooLargeError extends TenancyError {
  constructor(kind: string, maxBytes: number) {
    super(`A ${kind} may be at most ${Math.floor(maxBytes / 1024)} KB.`);
  }
}

/**
 * The bytes are not one of the accepted image formats — whatever the request's
 * `Content-Type` claimed, which is never consulted.
 */
export class BrandingAssetTypeUnsupportedError extends TenancyError {
  constructor(kind: string, accepted: readonly string[]) {
    super(`A ${kind} must be one of: ${accepted.join(', ')}.`);
  }
}

/**
 * The bytes exist for a row that names them and the store cannot produce them.
 * An operational fault — a restore that brought back the database without the
 * volume — and not the caller's problem.
 */
export class BrandingAssetUnreadableError extends TenancyError {
  constructor(readonly kind: string) {
    super(`The stored ${kind} could not be read.`);
  }
}

/** No `tenant_domains` row with that id in this tenant. Never `forbidden`. */
export class TenantDomainNotFoundError extends TenancyError {
  constructor() {
    super('No such domain.');
  }
}

/**
 * Somebody else holds this hostname.
 *
 * The message names nothing about the holder, and the service never reads the
 * conflicting row back — it could not, since the unique index is enforced below
 * row-level security, and a message naming the holder would leak one tenant to
 * another.
 */
export class TenantDomainTakenError extends TenancyError {
  constructor(readonly hostname: string) {
    super(
      `${hostname} is already claimed. If an unverified claim on it has lapsed it is released ` +
        'within the hour; otherwise choose another hostname.',
    );
  }
}

/** A hostname under the platform's own zone, which is ours to issue. */
export class PlatformHostnameNotClaimableError extends TenancyError {
  constructor(readonly hostname: string) {
    super(`${hostname} is a platform address and cannot be claimed as a custom domain.`);
  }
}

/**
 * A registrable domain rather than a subdomain of one.
 *
 * Refused because a root domain cannot take a `CNAME`, so the routing record the
 * claim would hand back is one the tenant's registrar will not accept. The
 * message names the fix, because "use a subdomain" is the entire remedy.
 */
export class ApexHostnameNotClaimableError extends TenancyError {
  constructor(readonly hostname: string) {
    super(
      `${hostname} looks like a root domain, and a root domain cannot be pointed at us. ` +
        `Use a subdomain such as support.${hostname} instead.`,
    );
  }
}

/** Past `MAX_CUSTOM_DOMAINS_PER_TENANT`. */
export class TooManyCustomDomainsError extends TenancyError {
  constructor(readonly limit: number) {
    super(
      `This workspace already holds ${limit} custom domains. Remove one before adding another.`,
    );
  }
}

/**
 * The environment has no `PLATFORM_EDGE_HOSTNAME`, so there is nowhere to tell
 * the tenant to point its DNS.
 *
 * Refusing the claim is deliberate: emitting a routing record with a blank
 * target would have the tenant publish a CNAME to nothing and wait for a
 * verification that cannot arrive, surfacing days later as a support ticket
 * rather than immediately.
 */
export class DomainRoutingUnconfiguredError extends TenancyError {
  constructor() {
    super('Custom domains are not available in this environment.');
  }
}

/** The platform subdomain is the tenant's floor and is never removable. */
export class PlatformDomainNotRemovableError extends TenancyError {
  constructor() {
    super(
      'A workspace address issued by the platform cannot be removed — it is the address that ' +
        'keeps working while a custom domain is being set up.',
    );
  }
}

/** Only a proved domain may become the primary one. */
export class DomainNotVerifiedError extends TenancyError {
  constructor(readonly hostname: string) {
    super(`${hostname} has not been verified yet, so it cannot be the workspace's main address.`);
  }
}

/** The per-domain floor between two ownership checks. */
export class DomainVerificationThrottledError extends TenancyError {
  constructor(readonly retryAfterSeconds: number) {
    super(`Wait ${retryAfterSeconds} seconds before checking this domain again.`);
  }
}
