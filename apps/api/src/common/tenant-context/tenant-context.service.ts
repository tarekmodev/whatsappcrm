import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { SessionPrincipal } from '@whatsappcrm/contracts';

export interface TenantContext {
  /** Correlation id shared by the log line, the error tracker and the error envelope. */
  requestId: string;
  /** Owning tenant, or `null` before the session has been resolved. */
  tenantId: string | null;
  /** Authenticated user, or `null` for unauthenticated and machine-to-machine calls. */
  userId: string | null;
  /**
   * The caller's role, permissions and team memberships, resolved once per
   * request (TAR-79). `null` on an unauthenticated path — the platform admin
   * surface, the health probe — which is why every reader has to handle it
   * rather than assume it.
   */
  principal: SessionPrincipal | null;
}

/**
 * The single binding point for "who is this work for".
 *
 * Deliberately `AsyncLocalStorage` rather than a Nest `REQUEST`-scoped provider:
 * request scoping forces Nest to re-instantiate the whole provider subtree per
 * request, and — more importantly — it does not exist at all for the two other
 * places tenant scoping is needed: queue workers (TAR-41's job processors) and
 * WebSocket event handlers (the inbox). ALS covers all three with one API.
 *
 * Downstream owners:
 *   - TAR-35 (auth) calls `setTenant()` once the session is verified.
 *   - TAR-39 defines how `tenantId` reaches the data layer.
 *   - TAR-41 reads `requestId`/`tenantId` for structured logging and error tracking.
 */
@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantContext>();

  /** Runs `callback` — and everything it awaits — inside `context`. */
  run<T>(context: TenantContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  get(): TenantContext | undefined {
    return this.storage.getStore();
  }

  get requestId(): string | null {
    return this.storage.getStore()?.requestId ?? null;
  }

  get tenantId(): string | null {
    return this.storage.getStore()?.tenantId ?? null;
  }

  get userId(): string | null {
    return this.storage.getStore()?.userId ?? null;
  }

  get principal(): SessionPrincipal | null {
    return this.storage.getStore()?.principal ?? null;
  }

  /** Attaches the resolved session to the active scope. */
  setTenant(tenantId: string, userId: string | null = null): void {
    const store = this.storage.getStore();

    if (!store) {
      throw new Error('setTenant() called outside of a tenant context scope');
    }

    store.tenantId = tenantId;
    store.userId = userId;
  }

  /**
   * Publishes the caller, once the principal source has produced one.
   *
   * Deliberately re-derives `tenantId` and `userId` from the principal rather
   * than trusting whatever the host resolution left there: the two must agree,
   * and the guard that calls this has already refused the request when they do
   * not (`tenant_mismatch`). Setting both here means there is one authority for
   * "who is this work for" once a caller is known, instead of two that can
   * drift.
   */
  setPrincipal(principal: SessionPrincipal): void {
    const store = this.storage.getStore();

    if (!store) {
      throw new Error('setPrincipal() called outside of a tenant context scope');
    }

    store.principal = principal;
    store.tenantId = principal.tenantId;
    store.userId = principal.userId;
  }

  /** Use where an absent caller is a bug: every route behind `PrincipalGuard`. */
  requirePrincipal(): SessionPrincipal {
    const principal = this.principal;

    if (!principal) {
      throw new Error(
        'No principal in scope: requirePrincipal() called on a path that PrincipalGuard did not run on',
      );
    }

    return principal;
  }

  /**
   * Use wherever a missing tenant is a bug rather than a valid state. Failing
   * loudly here is what stops an un-scoped query reaching another tenant's rows.
   */
  requireTenantId(): string {
    const tenantId = this.tenantId;

    if (!tenantId) {
      throw new Error('No tenant in scope: requireTenantId() called on an unscoped execution path');
    }

    return tenantId;
  }
}
