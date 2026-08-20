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
  Query,
  UseFilters,
} from '@nestjs/common';
import {
  IdSchema,
  WorkflowCreateInputSchema,
  WorkflowReorderInputSchema,
  WorkflowRunListQuerySchema,
  WorkflowTestInputSchema,
  WorkflowUpdateInputSchema,
  type CursorPage,
  type WorkflowCreateInput,
  type WorkflowListResponse,
  type WorkflowReorderInput,
  type WorkflowResponse,
  type WorkflowRunListQuery,
  type WorkflowRunResponse,
  type WorkflowTestInput,
  type WorkflowTestResponse,
  type WorkflowUpdateInput,
} from '@whatsappcrm/contracts';
import { z } from 'zod';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { WorkflowRunService } from './workflow-run.service';
import { WorkflowService } from './workflow.service';
import { translateWorkflowFailure } from './workflows.http';

/** `{id}` on every route below. Validated, so a non-UUID is a 400 and not a query. */
const WorkflowParamsSchema = z.object({ id: IdSchema });

/**
 * Workflow automation (TAR-27), the eight routes 0009 publishes.
 *
 * Behind the global pipeline like every other tenant controller — no guard is
 * declared here, and since TAR-58 that is what being fully protected looks like.
 *
 * ## `workflow:read` / `workflow:write`, granted to supervisor by this story
 *
 * 0004's matrix made them admin-only, with a reason that is exactly right about
 * the risk it names and does not apply to the launch action set: `tag`,
 * `reassign`, `notify` and `set_status`/`set_priority` are all internal, and
 * every one is something a supervisor can already do by hand with permissions
 * they already hold. 0009's security section rules for the supervisor and moves
 * the gate to where the risk is — a future action that reaches a *customer*
 * needs `workflow:send_message`, admin-only, checked at **write** time on the
 * action type, because a workflow runs with no principal to check when it fires.
 */
@Controller({ path: 'workflows', version: '1' })
@UseFilters(ApiExceptionFilter)
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowService,
    private readonly runs: WorkflowRunService,
  ) {}

  @Get()
  @RequirePermission('workflow:read')
  list(): Promise<WorkflowListResponse> {
    return this.workflows.list().catch(translateWorkflowFailure);
  }

  /**
   * Before `GET :id`, because Nest matches routes in declaration order and
   * `reorder` would otherwise be read as an id — and `IdSchema` would then
   * answer `validation_failed` for a route that exists.
   */
  @Post('reorder')
  @RequirePermission('workflow:write')
  @HttpCode(HttpStatus.OK)
  reorder(
    @Body(new ZodValidationPipe(WorkflowReorderInputSchema)) input: WorkflowReorderInput,
  ): Promise<WorkflowListResponse> {
    return this.workflows.reorder(input).catch(translateWorkflowFailure);
  }

  @Get(':id')
  @RequirePermission('workflow:read')
  get(
    @Param(new ZodValidationPipe(WorkflowParamsSchema)) params: { id: string },
  ): Promise<WorkflowResponse> {
    return this.workflows.get(params.id).catch(translateWorkflowFailure);
  }

  @Post()
  @RequirePermission('workflow:write')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(WorkflowCreateInputSchema)) input: WorkflowCreateInput,
  ): Promise<WorkflowResponse> {
    return this.workflows.create(input).catch(translateWorkflowFailure);
  }

  @Patch(':id')
  @RequirePermission('workflow:write')
  update(
    @Param(new ZodValidationPipe(WorkflowParamsSchema)) params: { id: string },
    @Body(new ZodValidationPipe(WorkflowUpdateInputSchema)) input: WorkflowUpdateInput,
  ): Promise<WorkflowResponse> {
    return this.workflows.update(params.id, input).catch(translateWorkflowFailure);
  }

  /** `204`, and idempotent — deleting an already-deleted workflow is not a 404. */
  @Delete(':id')
  @RequirePermission('workflow:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param(new ZodValidationPipe(WorkflowParamsSchema)) params: { id: string },
  ): Promise<void> {
    return this.workflows.delete(params.id).catch(translateWorkflowFailure);
  }

  /**
   * The dry run. **`workflow:write`, not `workflow:read`** — it reads one ticket
   * the caller may not otherwise be entitled to see, and reporting "condition
   * held: assigned to Sara" against a ticket they cannot open would be a
   * read-scope bypass. The service still checks `ticket:read_all` on the named
   * ticket rather than assuming this permission implies it.
   *
   * It writes nothing: no run row, no ticket write, no notification, no socket.
   */
  @Post(':id/test')
  @RequirePermission('workflow:write')
  @HttpCode(HttpStatus.OK)
  test(
    @Param(new ZodValidationPipe(WorkflowParamsSchema)) params: { id: string },
    @Body(new ZodValidationPipe(WorkflowTestInputSchema)) input: WorkflowTestInput,
  ): Promise<WorkflowTestResponse> {
    return this.runs.test(params.id, input).catch(translateWorkflowFailure);
  }

  /**
   * The run history — **this one paginates**, where the workflow list does not.
   * Runs grow with ticket volume, which is exactly the unbounded set 0002's rule
   * exists for.
   */
  @Get(':id/runs')
  @RequirePermission('workflow:read')
  listRuns(
    @Param(new ZodValidationPipe(WorkflowParamsSchema)) params: { id: string },
    @Query(new ZodValidationPipe(WorkflowRunListQuerySchema)) query: WorkflowRunListQuery,
  ): Promise<CursorPage<WorkflowRunResponse>> {
    return this.runs.list(params.id, query).catch(translateWorkflowFailure);
  }
}
