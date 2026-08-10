import type { SessionPrincipal } from '@whatsappcrm/contracts';
import type { Request } from 'express';

/**
 * Where the caller comes from.
 *
 * The seam TAR-35 plugs into. `PrincipalGuard` asks this for a principal and
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
   * The caller, or `null` when there is none — which `PrincipalGuard` turns into
   * `unauthenticated`. Throwing is reserved for a source that is misconfigured,
   * so "nobody is logged in" and "this deployment is broken" stay distinguishable.
   */
  resolve(request: Request, tenantId: string): Promise<SessionPrincipal | null>;
}

/** Inject with `@Inject(PRINCIPAL_SOURCE) private readonly source: PrincipalSource`. */
export const PRINCIPAL_SOURCE = Symbol('PRINCIPAL_SOURCE');
