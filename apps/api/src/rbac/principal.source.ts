import type { SessionPrincipal } from '@whatsappcrm/contracts';
import type { Request } from 'express';

/**
 * A live session that belongs to a **different** tenant from the one the request
 * host resolved (TAR-53, decision 2).
 *
 * Three uuids and no credential. It exists so `PrincipalGuard` can emit the
 * security event with enough in it to investigate — which session, whose, and
 * from where — without the guard itself ever reading across a tenant boundary.
 */
export interface ReplayedSession {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly userId: string;
}

/**
 * Why a request has, or has not, a caller.
 *
 * A discriminated union rather than `SessionPrincipal | null`, because there are
 * three outcomes and not two, and the third is the one that matters: a session
 * replayed against another tenant's domain is a security event, while an expired
 * cookie is a Tuesday. Collapsing them into `null` is what made
 * `tenant_mismatch` unreachable in practice — RLS makes a cross-tenant lookup
 * return zero rows, indistinguishable from an unknown token, so the alert TAR-39
 * asked to be paged on never fired.
 */
export type PrincipalResolution =
  | { readonly outcome: 'resolved'; readonly principal: SessionPrincipal }
  /** No credential, or one that names nothing anywhere. Answered `unauthenticated`. */
  | { readonly outcome: 'anonymous' }
  /** A live session for another tenant. Answered `tenant_mismatch`, and paged. */
  | { readonly outcome: 'replayed'; readonly session: ReplayedSession };

/** The two outcomes every source can produce, spelled once. */
export const ANONYMOUS: PrincipalResolution = { outcome: 'anonymous' };

export function resolved(principal: SessionPrincipal): PrincipalResolution {
  return { outcome: 'resolved', principal };
}

/**
 * Where the caller comes from.
 *
 * The seam TAR-35 plugged into. `PrincipalGuard` asks this for a resolution and
 * knows nothing about how it was produced, so swapping the interim stub for the
 * real session read is one binding in `RbacModule` plus deleting a file —
 * nothing downstream of the guard changes, and neither do the tests that
 * exercise the matrix.
 *
 * Implementations resolve **within the tenant already in scope**. `tenantId` is
 * passed rather than read from the request, because it comes from
 * `HostTenantGuard` — the host, not anything the caller can set. An
 * implementation that derived the tenant from a credential instead would let a
 * replayed session pick its own tenant.
 */
export interface PrincipalSource {
  /**
   * The caller, or why there is none. Throwing is reserved for a source that is
   * misconfigured, so "nobody is signed in" and "this deployment is broken" stay
   * distinguishable — the ordinary rejections are outcomes, not exceptions.
   */
  resolve(request: Request, tenantId: string): Promise<PrincipalResolution>;
}

/** Inject with `@Inject(PRINCIPAL_SOURCE) private readonly source: PrincipalSource`. */
export const PRINCIPAL_SOURCE = Symbol('PRINCIPAL_SOURCE');
