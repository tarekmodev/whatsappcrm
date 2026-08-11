import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionGuard } from '../../rbac/permission.guard';
import { PrincipalGuard } from '../../rbac/principal.guard';
import { HostTenantGuard } from '../../tenancy/host-tenant.guard';

/**
 * Installs TAR-39's request pipeline globally (TAR-58).
 *
 * ## Why global rather than `@UseGuards` per controller
 *
 * Until this module existed, every tenant-facing controller declared
 * `@UseGuards(HostTenantGuard, PrincipalGuard, PermissionGuard)` for itself —
 * and two of them, `MediaController` and `MessageTemplatesController`, shipped
 * without it and stood on a hand-written `requireTenant()` instead. That is the
 * failure mode the arrangement guarantees: the protection is opt-in, so the
 * missing line is invisible in review because it is *not there*, and the first
 * symptom is a route serving another tenant's rows.
 *
 * Registered here, the three guards run on every route in the application,
 * including the ones later stories add. A new controller is closed the moment it
 * is written, and opening it takes a decorator somebody has to type — see
 * `route-access.ts` for the two that exist and what each gives up.
 *
 * ## Order is the contract
 *
 * Nest runs global guards in the order their `APP_GUARD` providers are declared,
 * and each of these three depends on the last:
 *
 *   1. `HostTenantGuard`  — **where** the request is, from the `Host` header.
 *   2. `PrincipalGuard`   — **who** is calling, from the session cookie, checked
 *                           against the tenant stage 1 resolved.
 *   3. `PermissionGuard`  — **may they**, from `@RequirePermission`.
 *
 * Reordering them does not fail loudly at boot, so it is asserted end to end in
 * `request-pipeline.http.spec.ts`: an unknown host answers `tenant_not_found`
 * before it can answer `unauthenticated`, which is only true if stage 1 ran
 * first. Stages 4 and 6 of the published pipeline — `TenantStatusGuard` (TAR-36)
 * and `FeatureGuard` (TAR-37) — slot in here when those stories land.
 *
 * ## Why this module owns them rather than `RbacModule`
 *
 * The three guards live in three different bounded contexts — tenancy, RBAC —
 * and the pipeline is a property of the application, not of any one of them.
 * Putting the registration in a feature module would make "what runs on every
 * request" something you have to already know where to look for. Every
 * dependency the guards need comes from a global module (`PrismaModule`,
 * `TenantContextModule`, `RbacModule`), so this module imports nothing.
 */
@Module({
  providers: [
    { provide: APP_GUARD, useClass: HostTenantGuard },
    { provide: APP_GUARD, useClass: PrincipalGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class RequestPipelineModule {}
