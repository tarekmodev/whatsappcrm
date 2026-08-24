import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  UseFilters,
  type PipeTransform,
} from '@nestjs/common';
import {
  OnboardingStepIdSchema,
  OnboardingStepUpdateInputSchema,
  type OnboardingChecklistResponse,
  type OnboardingStepId,
  type OnboardingStepUpdateInput,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { translateOnboardingFailure } from './onboarding.http';
import { OnboardingStepNotFoundError } from './tenant-onboarding.errors';
import { TenantOnboardingReader } from './tenant-onboarding.reader';
import { TenantOnboardingService } from './tenant-onboarding.service';

/**
 * The guided setup checklist a new tenant admin lands in after signup (TAR-36,
 * TAR-407), as TAR-832 ratifies it — a third controller on `tenant`, alongside
 * `TenantController` and `TenantLifecycleController`.
 *
 * ## Permissions
 *
 * `tenant:settings` on **both** routes. Read and write share one permission
 * deliberately: skipping a setup prompt is not a second authority, and inventing
 * `onboarding:write` would add a row to `ROLE_PERMISSIONS` and no safety. That
 * permission is admin-only today — absent from `SUPERVISOR_PERMISSIONS` and
 * therefore from `AGENT_PERMISSIONS` — so an admin reads and writes, and a
 * supervisor or agent gets 403.
 *
 * ## Not `@AvailableWhileSuspended()`
 *
 * Deliberately off the recovery allowlist, unlike the lifecycle read. A
 * suspended tenant's admin does not need to onboard; the allowlist exists so
 * they can see *why* they are suspended and undo it.
 *
 * ## No tenant identifier anywhere
 *
 * Neither route has a path, query or body field naming a tenant. The id comes
 * from `TenantContextService`, which carries what `HostTenantGuard` resolved
 * from the request host — and the tables underneath carry `FORCE ROW LEVEL
 * SECURITY` besides.
 */
@Controller({ path: 'tenant', version: '1' })
@UseFilters(ApiExceptionFilter)
export class TenantOnboardingController {
  constructor(
    private readonly reader: TenantOnboardingReader,
    private readonly onboarding: TenantOnboardingService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `GET /api/v1/tenant/onboarding` — the whole checklist.
   *
   * **Never 404s.** A tenant that exists always has a checklist; one with no rows
   * anywhere gets three `pending` steps, because a client that had to tell
   * "missing" from "not started" apart would grow a second empty state for no
   * gain.
   */
  @Get('onboarding')
  @RequirePermission('tenant:settings')
  // Per-tenant and per-session on a path identical for every tenant, so anything
  // caching it on the URL alone is a cross-tenant leak — the warning
  // `tenant.controller.ts` already carries for the branding routes.
  @Header('Cache-Control', 'private, no-store')
  async read(): Promise<OnboardingChecklistResponse> {
    return await this.reader
      .read(this.tenantContext.requireTenantId())
      .catch((error: unknown) => translateOnboardingFailure(error));
  }

  /**
   * `PATCH /api/v1/tenant/onboarding/steps/{stepId}` — put a step off, or put it
   * back.
   *
   * Answers 200 with the **whole** checklist rather than the one step, so a
   * caller cannot render a progress meter from a checklist it has half of.
   *
   * An unknown `stepId` is `404 not_found` rather than the `400
   * validation_failed` a Zod pipe would naturally emit — see
   * `onboardingStepIdPipe`.
   */
  @Patch('onboarding/steps/:stepId')
  @RequirePermission('tenant:settings')
  @Header('Cache-Control', 'private, no-store')
  async updateStep(
    @Param('stepId', onboardingStepIdPipe()) stepId: OnboardingStepId,
    @Body(new ZodValidationPipe(OnboardingStepUpdateInputSchema)) input: OnboardingStepUpdateInput,
  ): Promise<OnboardingChecklistResponse> {
    return await this.onboarding
      .apply({
        tenantId: this.tenantContext.requireTenantId(),
        stepId,
        intent: input.intent,
      })
      .catch((error: unknown) => translateOnboardingFailure(error));
  }
}

/**
 * The path parameter against `OnboardingStepIdSchema`, answering **404** rather
 * than 400 for a value that is not a member (TAR-832, divergence 2).
 *
 * A path segment names a resource, and a client that asked for a step that does
 * not exist got a 404 from every other resource route in this API — including,
 * as it happens, from the mock this endpoint replaces. `ZodValidationPipe` is
 * the wrong tool here for exactly that reason: it maps every parse failure to
 * `validation_failed`, which is right for a body and wrong for an id.
 */
function onboardingStepIdPipe(): PipeTransform<unknown, OnboardingStepId> {
  return {
    transform: (value: unknown): OnboardingStepId => {
      const parsed = OnboardingStepIdSchema.safeParse(value);

      if (!parsed.success) {
        translateOnboardingFailure(new OnboardingStepNotFoundError());
      }

      return parsed.data;
    },
  };
}
