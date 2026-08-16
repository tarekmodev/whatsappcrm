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
  CannedResponseCreateInputSchema,
  CannedResponseUpdateInputSchema,
  IdSchema,
  type CannedResponseCreateInput,
  type CannedResponseListResponse,
  type CannedResponseResponse,
  type CannedResponseUpdateInput,
} from '@whatsappcrm/contracts';
import { z } from 'zod';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CannedResponsesService } from './canned-responses.service';
import { translateCannedResponseFailure } from './canned-responses.http';

/** `{id}` on every route below. Validated, so a non-UUID is a 400 and not a query. */
const CannedResponseParamsSchema = z.object({ id: IdSchema });

/**
 * Canned responses (TAR-31), the five routes 0011 publishes.
 *
 * Behind the global pipeline like every other tenant controller — no guard is
 * declared here, and since TAR-58 that is what being fully protected looks like.
 * `PermissionGuard` denies by default, so every route states its permission.
 *
 * `canned_response:read` to look, `canned_response:write` to change, which 0004
 * grants to agent-and-above and supervisor-and-above respectively and `rbac.ts`
 * has shipped since TAR-39. TAR-31's wording says "an admin edits a canned
 * response"; 0004 already reads that as "a person with the write permission",
 * and 0011 does not narrow it.
 *
 * There is deliberately **no shortcut-lookup route**. 0011 decision 1 resolves a
 * typed token in the console against its copy of the whole set, which the list
 * below returns — a lookup that answers only after the agent stops typing cannot
 * drive a picker, and adding one would put a request on the keystroke path for
 * data the console already holds.
 */
@Controller({ path: 'canned-responses', version: '1' })
@UseFilters(ApiExceptionFilter)
export class CannedResponsesController {
  constructor(private readonly cannedResponses: CannedResponsesService) {}

  /** `GET /api/v1/canned-responses` — the whole set, which is what the picker needs. */
  @Get()
  @RequirePermission('canned_response:read')
  list(): Promise<CannedResponseListResponse> {
    return this.cannedResponses.list();
  }

  @Get(':id')
  @RequirePermission('canned_response:read')
  get(
    @Param(new ZodValidationPipe(CannedResponseParamsSchema)) params: { id: string },
  ): Promise<CannedResponseResponse> {
    return this.cannedResponses.get(params.id).catch(translateCannedResponseFailure);
  }

  @Post()
  @RequirePermission('canned_response:write')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CannedResponseCreateInputSchema)) input: CannedResponseCreateInput,
  ): Promise<CannedResponseResponse> {
    return this.cannedResponses.create(input).catch(translateCannedResponseFailure);
  }

  @Patch(':id')
  @RequirePermission('canned_response:write')
  update(
    @Param(new ZodValidationPipe(CannedResponseParamsSchema)) params: { id: string },
    @Body(new ZodValidationPipe(CannedResponseUpdateInputSchema)) input: CannedResponseUpdateInput,
  ): Promise<CannedResponseResponse> {
    return this.cannedResponses.update(params.id, input).catch(translateCannedResponseFailure);
  }

  /** `204`, and idempotent — deleting an already-deleted response is not a 404. */
  @Delete(':id')
  @RequirePermission('canned_response:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param(new ZodValidationPipe(CannedResponseParamsSchema)) params: { id: string },
  ): Promise<void> {
    return this.cannedResponses.delete(params.id).catch(translateCannedResponseFailure);
  }
}
