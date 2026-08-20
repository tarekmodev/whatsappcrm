import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  AdminTenantCancelInputSchema,
  AdminTenantDeleteInputSchema,
  AdminTenantParamsSchema,
  CursorPageQuerySchema,
  DeactivateTenantInputSchema,
  DeactivateTenantParamsSchema,
  ProvisionTenantInputSchema,
  type AdminTenantCancelInput,
  type AdminTenantDeleteInput,
  type AdminTenantLifecycleEvent,
  type AdminTenantLifecycleResponse,
  type AdminTenantParams,
  type CursorPage,
  type CursorPageQuery,
  type DeactivateTenantInput,
  type DeactivateTenantParams,
  type DeactivatedTenantResponse,
  type ProvisionTenantInput,
  type ProvisionedTenantResponse,
} from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { ApiException } from '../../common/errors/api.exception';
import { PlatformRoute } from '../../common/request-pipeline/route-access';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AdminTenantLifecycleService } from '../lifecycle/admin-tenant-lifecycle.service';
import { LifecycleEventsRepository } from '../lifecycle/lifecycle-events.repository';
import { translateLifecycleFailure } from '../lifecycle/lifecycle.http';
import type { TenantLifecycleState } from '../lifecycle/tenant-lifecycle.service';
import { TenantNotFoundError } from '../tenant-deactivation.errors';
import {
  TenantDeactivationService,
  type DeactivateTenantResult,
} from '../tenant-deactivation.service';
import { PlatformHostnameTakenError, TenantSlugTakenError } from '../tenant-provisioning.errors';
import {
  TenantProvisioningService,
  type ProvisionTenantResult,
} from '../tenant-provisioning.service';
import { PlatformAdminGuard } from './platform-admin.guard';

/**
 * The platform-admin tenant surface. Every route here is operated by us, never
 * by a customer, and is authenticated by `PlatformAdminGuard` rather than by a
 * tenant session.
 *
 * The guard is declared on the controller rather than per route, so a route
 * added later is protected by default instead of by remembering.
 *
 * `@PlatformRoute()` is what takes it out of the global tenant pipeline (TAR-39,
 * "`/api/v1/admin/*` skips stages 2–6"): the operator is not a user inside any
 * tenant, there is no session to resolve them against, and provisioning has to
 * work before the first tenant exists. It removes the *tenant* pipeline and
 * nothing else — `PlatformAdminGuard` below is still the authentication, and the
 * one route that touches tenant data enters that tenant's scope explicitly
 * through `AdminTenantScopeService`.
 */
@Controller({ path: 'admin/tenants', version: '1' })
@PlatformRoute()
@UseGuards(PlatformAdminGuard)
@UseFilters(ApiExceptionFilter)
export class AdminTenantsController {
  constructor(
    private readonly provisioning: TenantProvisioningService,
    private readonly deactivation: TenantDeactivationService,
    private readonly lifecycleAdmin: AdminTenantLifecycleService,
    private readonly events: LifecycleEventsRepository,
  ) {}

  /**
   * `POST /api/v1/admin/tenants` — provision a tenant (TAR-19).
   *
   * Idempotent on `slug`, and the status code is how the caller tells the two
   * cases apart: `201` when this call created the tenant, `200` when it already
   * existed and nothing changed. The body is the same either way.
   *
   * Written with `@Res({ passthrough: true })` rather than a fixed `@HttpCode`
   * because the code is genuinely part of the answer here — a script that
   * re-runs provisioning needs to know whether it just created something.
   */
  @Post()
  // Nest defaults POST to 201; declared explicitly so the override below reads
  // as a deliberate narrowing rather than as a fight with the framework.
  @HttpCode(HttpStatus.CREATED)
  async provision(
    @Body(new ZodValidationPipe(ProvisionTenantInputSchema)) input: ProvisionTenantInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProvisionedTenantResponse> {
    const result = await this.provisioning
      .provision(input)
      .catch((error: unknown) => translateProvisioningFailure(error));

    if (!result.created) {
      response.status(HttpStatus.OK);
    }

    return toResponse(result);
  }

  /**
   * `POST /api/v1/admin/tenants/{slug}/deactivate` — revoke a tenant's access
   * while keeping its data (TAR-51).
   *
   * Always `200`, unlike provisioning: deactivation creates nothing, and a
   * repeat call is a no-op on a tenant that is already inaccessible rather than
   * a different outcome worth a different code. The body reports the state
   * either way.
   *
   * The effect is immediate and platform-wide for that tenant — its agents stop
   * reaching their data on their very next query, including through open
   * sessions and in-flight background jobs — so this route is as destructive as
   * the admin surface gets short of deletion, and it is the reason the guard is
   * declared on the controller rather than per route.
   */
  @Post(':slug/deactivate')
  @HttpCode(HttpStatus.OK)
  async deactivate(
    @Param(new ZodValidationPipe(DeactivateTenantParamsSchema)) params: DeactivateTenantParams,
    @Body(new ZodValidationPipe(DeactivateTenantInputSchema)) input: DeactivateTenantInput,
  ): Promise<DeactivatedTenantResponse> {
    const result = await this.deactivation
      .deactivate({ slug: params.slug, reason: input.reason })
      .catch((error: unknown) => translateDeactivationFailure(error));

    return toDeactivatedResponse(result);
  }

  /**
   * `POST /api/v1/admin/tenants/{slug}/reactivate` — deactivation's inverse
   * (TAR-36, ADR 0009).
   *
   * The operator half of the way back. `suspended → active`, `past_due → active`
   * and `cancelled → active` are all legal on `operator_action`, so this is the
   * one route that can restore a tenant from any of the three states an
   * automated timer put it in — which matters because reactivation at v1 is
   * otherwise driven by a payment webhook nobody has wired yet.
   *
   * **No data is re-provisioned.** The tenant's rows were never deleted; what
   * this changes is the status the two gates read, so access returns on the very
   * next statement. That is TAR-36's third acceptance criterion, and it is a
   * property of suspension having been a status change all along rather than
   * anything this route does.
   */
  @Post(':slug/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivate(
    @Param(new ZodValidationPipe(AdminTenantParamsSchema)) params: AdminTenantParams,
  ): Promise<AdminTenantLifecycleResponse> {
    return await this.operatorTransition(params.slug, 'active');
  }

  /**
   * `POST /api/v1/admin/tenants/{slug}/cancel` — end a tenant's subscription on
   * its behalf.
   *
   * The same edge the tenant's own admin reaches through `POST /tenant/cancel`,
   * with `operator_action` on the trail instead of `user_action` and the
   * operator's credential label naming who did it. `reason` is recorded and
   * never rendered to the tenant.
   */
  @Post(':slug/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param(new ZodValidationPipe(AdminTenantParamsSchema)) params: AdminTenantParams,
    @Body(new ZodValidationPipe(AdminTenantCancelInputSchema)) input: AdminTenantCancelInput,
  ): Promise<AdminTenantLifecycleResponse> {
    return await this.operatorTransition(params.slug, 'cancelled', input.reason);
  }

  /**
   * `POST /api/v1/admin/tenants/{slug}/delete` — schedule a deletion, or force
   * one.
   *
   * Without `force` it is the tenant-facing route's twin: cancel with a grace
   * period, reach `suspended`, purge when the retention window elapses.
   *
   * With `force` it goes straight to `suspended` and moves `purge_at` to now, so
   * the next sweep purges. That exists for a right-to-erasure request that
   * cannot wait 44 days, and it is deliberately the **only** way to shorten the
   * window: there is still one road to `deleted` and one clock on it, and this
   * moves the clock rather than adding a second road. Both halves are audited
   * with `trigger: operator_action` and the operator's credential label.
   */
  @Post(':slug/delete')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param(new ZodValidationPipe(AdminTenantParamsSchema)) params: AdminTenantParams,
    @Body(new ZodValidationPipe(AdminTenantDeleteInputSchema)) input: AdminTenantDeleteInput,
  ): Promise<AdminTenantLifecycleResponse> {
    if (!input.force) {
      return await this.operatorTransition(params.slug, 'cancelled', input.reason);
    }

    const state = await this.operatorTransition(params.slug, 'suspended', input.reason);

    return await this.lifecycleAdmin
      .expedite(state.id)
      .then(toAdminLifecycleResponse)
      .catch((error: unknown) => translateLifecycleFailure(error));
  }

  /**
   * `GET /api/v1/admin/tenants/{slug}/lifecycle` — the tenant's whole history,
   * newest first, **including `reason`**.
   *
   * The operator's copy of `GET /tenant/lifecycle/events`. The difference is one
   * column and it is the point of having two routes: `reason` is where an
   * operator writes why they shut a tenant off, and 0009's security section says
   * that is not a sentence to show a customer.
   */
  @Get(':slug/lifecycle')
  async lifecycle(
    @Param(new ZodValidationPipe(AdminTenantParamsSchema)) params: AdminTenantParams,
    @Query(new ZodValidationPipe(CursorPageQuerySchema)) query: CursorPageQuery,
  ): Promise<CursorPage<AdminTenantLifecycleEvent>> {
    const tenant = await this.lifecycleAdmin
      .bySlug(params.slug)
      .catch((error: unknown) => translateLifecycleFailure(error));

    return await this.events
      .forOperator(tenant.id, query)
      .catch((error: unknown) => translateLifecycleFailure(error));
  }

  /**
   * The shape the three operator writes share.
   *
   * The slug is resolved to an id first, because `transition()` names a tenant
   * by id — one identity for the state machine, whatever the caller had in front
   * of them. The actor comes from the request scope through
   * `AdminTenantLifecycleService`, so the credential label on the trail is the
   * one `PlatformAdminGuard` authenticated and not one a handler assembled.
   */
  private async operatorTransition(
    slug: string,
    to: 'active' | 'cancelled' | 'suspended',
    reason?: string,
  ): Promise<AdminTenantLifecycleResponse> {
    return await this.lifecycleAdmin
      .transitionBySlug(slug, to, reason)
      .then(toAdminLifecycleResponse)
      .catch((error: unknown) => translateLifecycleFailure(error));
  }
}

/**
 * Maps the lifecycle state onto the published operator response. Explicit rather
 * than spread, so adding a column to the projection cannot quietly add a field
 * to the API.
 */
function toAdminLifecycleResponse(state: TenantLifecycleState): AdminTenantLifecycleResponse {
  return {
    id: state.id,
    slug: state.slug,
    name: state.name,
    status: state.status,
    trialEndsAt: state.trialEndsAt?.toISOString() ?? null,
    gracePeriodEndsAt: state.gracePeriodEndsAt?.toISOString() ?? null,
    suspendedAt: state.suspendedAt?.toISOString() ?? null,
    cancelledAt: state.cancelledAt?.toISOString() ?? null,
    purgeAt: state.purgeAt?.toISOString() ?? null,
    deletedAt: state.deletedAt?.toISOString() ?? null,
  };
}

function translateProvisioningFailure(error: unknown): never {
  if (error instanceof PlatformHostnameTakenError || error instanceof TenantSlugTakenError) {
    throw new ApiException('conflict', error.message);
  }

  // Not ours to interpret. It reaches Nest's default handler as a 500, which is
  // the correct answer for a fault, and TAR-41's global filter will give it the
  // envelope and the log line.
  throw error;
}

/**
 * Maps the service result onto the published response. Explicit rather than
 * spread, so adding a column to the query cannot quietly add a field to the
 * API — the mapping is where a `passwordHash` would otherwise escape.
 */
function toResponse({ tenant }: ProvisionTenantResult): ProvisionedTenantResponse {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    primaryHostname: tenant.primaryHostname,
    settings: { timezone: tenant.timezone, locale: tenant.locale },
    createdAt: tenant.createdAt.toISOString(),
  };
}

function translateDeactivationFailure(error: unknown): never {
  if (error instanceof TenantNotFoundError) {
    // The operator asked about a tenant that does not exist — a mistyped slug
    // during an incident, most likely. Worth saying so: answering 200 would let
    // them believe a tenant that is still serving traffic had been stopped.
    throw new ApiException('not_found', error.message);
  }

  throw error;
}

function toDeactivatedResponse({ tenant }: DeactivateTenantResult): DeactivatedTenantResponse {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    suspendedAt: tenant.suspendedAt?.toISOString() ?? null,
  };
}
