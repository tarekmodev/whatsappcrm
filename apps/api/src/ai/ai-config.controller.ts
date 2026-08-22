import { Body, Controller, Get, Patch, UseFilters } from '@nestjs/common';
import {
  UpdateAiConfigInputSchema,
  type AiConfigResponse,
  type UpdateAiConfigInput,
} from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AiConfigService } from './ai-config.service';
import { translateAiFailure } from './ai.http';

/**
 * The tenant's chatbot configuration (TAR-28, 0010's endpoint surface).
 *
 * A singleton resource — one row per tenant — so there is no id in the path and
 * no list. `PATCH` of named fields to fixed values is idempotent by
 * construction, which is why no `Idempotency-Key` is required.
 *
 * **The read is deliberately not plan-gated and the write is.** A tenant whose
 * plan lacks `ai_chatbot` still reads this endpoint, with `isEnabled: false` and
 * `readiness.blockers` naming `feature_not_in_plan`, so the console can render
 * an upsell rather than a 403 page. `PATCH` answers `feature_not_in_plan`.
 */
@Controller({ path: 'ai/config', version: '1' })
@UseFilters(ApiExceptionFilter)
export class AiConfigController {
  constructor(private readonly config: AiConfigService) {}

  @Get()
  @RequirePermission('ai:read')
  get(): Promise<AiConfigResponse> {
    return this.config.get().catch(translateAiFailure);
  }

  @Patch()
  @RequirePermission('ai:write')
  update(
    @Body(new ZodValidationPipe(UpdateAiConfigInputSchema)) input: UpdateAiConfigInput,
  ): Promise<AiConfigResponse> {
    return this.config.update(input).catch(translateAiFailure);
  }
}
