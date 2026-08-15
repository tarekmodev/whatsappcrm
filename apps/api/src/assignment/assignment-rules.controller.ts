import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseFilters,
} from '@nestjs/common';
import {
  AssignmentRuleCreateInputSchema,
  AssignmentRuleReorderInputSchema,
  AssignmentRuleUpdateInputSchema,
  IdSchema,
  type AssignmentRuleCreateInput,
  type AssignmentRuleListResponse,
  type AssignmentRuleReorderInput,
  type AssignmentRuleResponse,
  type AssignmentRuleUpdateInput,
} from '@whatsappcrm/contracts';
import { z } from 'zod';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AssignmentRulesService } from './assignment-rules.service';
import { translateAssignmentFailure } from './assignment.http';

/** `{id}` on every route below. Validated, so a non-UUID is a 400 and not a query. */
const AssignmentRuleParamsSchema = z.object({ id: IdSchema });

/**
 * Routing rules (TAR-24), the six routes 0007 publishes.
 *
 * Behind the global pipeline like every other tenant controller — no guard is
 * declared here, and since TAR-58 that is what being fully protected looks like.
 *
 * `assignment_rule:read` / `assignment_rule:write`, which 0004 grants to
 * supervisor and admin and `rbac.ts` has shipped since TAR-39. Deliberately not
 * `channel:manage`, which TAR-279's issue text proposed: that permission is
 * admin-only and holds the Meta credentials, and routing under it would
 * contradict TAR-22's third acceptance criterion, which puts assignment settings
 * in a supervisor's hands.
 */
@Controller({ path: 'assignment-rules', version: '1' })
@UseFilters(ApiExceptionFilter)
export class AssignmentRulesController {
  constructor(private readonly rules: AssignmentRulesService) {}

  @Get()
  @RequirePermission('assignment_rule:read')
  list(): Promise<AssignmentRuleListResponse> {
    return this.rules.list();
  }

  /**
   * Before `GET :id`, because Nest matches routes in declaration order and
   * `reorder` would otherwise be read as an id — and `IdSchema` would then
   * answer `validation_failed` for a route that exists.
   */
  @Post('reorder')
  @RequirePermission('assignment_rule:write')
  @HttpCode(HttpStatus.OK)
  reorder(
    @Body(new ZodValidationPipe(AssignmentRuleReorderInputSchema))
    input: AssignmentRuleReorderInput,
  ): Promise<AssignmentRuleListResponse> {
    return this.rules.reorder(input).catch(translateAssignmentFailure);
  }

  @Get(':id')
  @RequirePermission('assignment_rule:read')
  get(
    @Param(new ZodValidationPipe(AssignmentRuleParamsSchema)) params: { id: string },
  ): Promise<AssignmentRuleResponse> {
    return this.rules.get(params.id).catch(translateAssignmentFailure);
  }

  @Post()
  @RequirePermission('assignment_rule:write')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(AssignmentRuleCreateInputSchema)) input: AssignmentRuleCreateInput,
  ): Promise<AssignmentRuleResponse> {
    return this.rules.create(input).catch(translateAssignmentFailure);
  }

  @Patch(':id')
  @RequirePermission('assignment_rule:write')
  update(
    @Param(new ZodValidationPipe(AssignmentRuleParamsSchema)) params: { id: string },
    @Body(new ZodValidationPipe(AssignmentRuleUpdateInputSchema)) input: AssignmentRuleUpdateInput,
  ): Promise<AssignmentRuleResponse> {
    return this.rules.update(params.id, input).catch(translateAssignmentFailure);
  }

  /** `204`, and idempotent — deleting an already-deleted rule is not a 404. */
  @Delete(':id')
  @RequirePermission('assignment_rule:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param(new ZodValidationPipe(AssignmentRuleParamsSchema)) params: { id: string },
  ): Promise<void> {
    return this.rules.delete(params.id).catch(translateAssignmentFailure);
  }
}
