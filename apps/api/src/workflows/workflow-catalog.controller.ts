import { Controller, Get, UseFilters } from '@nestjs/common';
import type { WorkflowCatalogResponse } from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { WorkflowCatalogService } from './workflow-catalog.service';

/**
 * `GET /api/v1/workflow-catalog` — the vocabulary the builder renders from.
 *
 * Its own controller rather than a route on `WorkflowsController`, because the
 * path is a sibling of `/workflows` rather than a child of it: it is not a
 * workflow, it is what a workflow may be made of. Mounting it at
 * `/workflows/catalog` would collide with `GET /workflows/{id}` on Nest's
 * declaration-order matching, which is the trap `reorder` already has to be
 * declared around.
 *
 * `workflow:read`, because it publishes no tenant data at all — only the
 * server's own vocabulary — and the console needs it before it can render the
 * rule list a reader is entitled to see.
 */
@Controller({ path: 'workflow-catalog', version: '1' })
@UseFilters(ApiExceptionFilter)
export class WorkflowCatalogController {
  constructor(private readonly catalog: WorkflowCatalogService) {}

  @Get()
  @RequirePermission('workflow:read')
  get(): WorkflowCatalogResponse {
    return this.catalog.get();
  }
}
