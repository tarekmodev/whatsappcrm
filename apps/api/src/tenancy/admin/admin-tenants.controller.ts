import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ProvisionTenantInputSchema,
  type ProvisionTenantInput,
  type ProvisionedTenantResponse,
} from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { ApiException } from '../../common/errors/api.exception';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
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
 */
@Controller({ path: 'admin/tenants', version: '1' })
@UseGuards(PlatformAdminGuard)
@UseFilters(ApiExceptionFilter)
export class AdminTenantsController {
  constructor(private readonly provisioning: TenantProvisioningService) {}

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
