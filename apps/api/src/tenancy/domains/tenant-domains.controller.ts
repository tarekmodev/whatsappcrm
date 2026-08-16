import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseFilters,
} from '@nestjs/common';
import {
  TenantDomainCreateInputSchema,
  TenantDomainParamsSchema,
  type TenantDomain,
  type TenantDomainCreateInput,
  type TenantDomainListResponse,
  type TenantDomainParams,
} from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { translateTenancyFailure } from '../tenancy.http';
import { TenantDomainsService } from './tenant-domains.service';

/**
 * A tenant's custom domains (TAR-29, TAR-416's domain endpoints).
 *
 * Everything here is `domain:write`, list included. That is deliberate rather
 * than lazy: the settings screen is the only reader, DNS control is not the same
 * authority as reading a workspace name, and `PermissionGuard` refuses a route
 * that declares no posture at all — so "no permission" is not an option.
 *
 * The verbs follow 0002's conventions: non-CRUD operations are sub-resource
 * `POST`s rather than fields in a body. `verify` and `primary` are operations
 * with consequences beyond a column — one reaches out to DNS, the other changes
 * where a password-reset link is mailed — and a `PATCH` that set a status would
 * invite a client to set it directly.
 *
 * ## The tenant is never in the request
 *
 * No route here takes a tenant id, slug or hostname as a way of *selecting* the
 * tenant. `{id}` names a row, and the lookup is scoped by RLS to the tenant
 * `HostTenantGuard` resolved from the host — so an id belonging to another
 * tenant is `not_found`, which is the same answer an id belonging to nobody
 * gets.
 */
@Controller({ path: 'tenant/domains', version: '1' })
@UseFilters(ApiExceptionFilter)
export class TenantDomainsController {
  constructor(private readonly domains: TenantDomainsService) {}

  @Get()
  @RequirePermission('domain:write')
  async list(): Promise<TenantDomainListResponse> {
    const items = await this.domains
      .list()
      .catch((error: unknown) => translateTenancyFailure(error));

    return { items };
  }

  /**
   * Claims a hostname and issues the DNS challenge.
   *
   * `201` when this call created the claim, `200` when the tenant already held
   * it — the same shape `POST /admin/tenants` uses, and for the same reason: a
   * double-submitted form is not a conflict, and a client re-running the call
   * needs to know whether it just created something.
   *
   * A hostname **another** tenant holds is `409 conflict`, from the unique
   * index, with a message that says nothing about the holder.
   */
  @Post()
  @RequirePermission('domain:write')
  @HttpCode(HttpStatus.CREATED)
  async claim(
    @Body(new ZodValidationPipe(TenantDomainCreateInputSchema)) input: TenantDomainCreateInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TenantDomain> {
    const result = await this.domains
      .claim(input.hostname)
      .catch((error: unknown) => translateTenancyFailure(error));

    if (!result.created) {
      response.status(HttpStatus.OK);
    }

    return result.domain;
  }

  /**
   * Checks the DNS challenge now.
   *
   * Always `200`, including when the record is not there yet. That is not
   * leniency: nothing went wrong with the *request*, and "not verified yet" is a
   * state on the resource the response already carries — `status` and
   * `verification.lastFailureReason` say which of the four reasons it was. An
   * error envelope here would make a settings screen render a failure banner for
   * the ordinary case of DNS not having propagated.
   *
   * `429` is the exception, and it is about the caller rather than the domain:
   * each check is an outbound query to a nameserver the tenant nominated.
   */
  @Post(':id/verify')
  @RequirePermission('domain:write')
  @HttpCode(HttpStatus.OK)
  async verify(
    @Param(new ZodValidationPipe(TenantDomainParamsSchema)) params: TenantDomainParams,
  ): Promise<TenantDomain> {
    return await this.domains
      .verify(params.id)
      .catch((error: unknown) => translateTenancyFailure(error));
  }

  /** Makes a verified domain the address the platform mails links to. */
  @Post(':id/primary')
  @RequirePermission('domain:write')
  @HttpCode(HttpStatus.OK)
  async setPrimary(
    @Param(new ZodValidationPipe(TenantDomainParamsSchema)) params: TenantDomainParams,
  ): Promise<TenantDomain> {
    return await this.domains
      .setPrimary(params.id)
      .catch((error: unknown) => translateTenancyFailure(error));
  }

  /**
   * Releases a custom domain. It stops resolving immediately — the row is what
   * host resolution reads.
   *
   * Refuses a platform subdomain: a tenant with no hostname is unreachable and
   * cannot be recovered without operator help.
   */
  @Delete(':id')
  @RequirePermission('domain:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param(new ZodValidationPipe(TenantDomainParamsSchema)) params: TenantDomainParams,
  ): Promise<void> {
    await this.domains.remove(params.id).catch((error: unknown) => translateTenancyFailure(error));
  }
}
