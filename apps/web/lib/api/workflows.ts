import 'server-only';

import {
  WorkflowCatalogResponseSchema,
  WorkflowListResponseSchema,
  WorkflowResponseSchema,
  WorkflowRunResponseSchema,
  WorkflowTestResponseSchema,
  type WorkflowCatalogResponse,
  type WorkflowCreateInput,
  type WorkflowReorderInput,
  type WorkflowResponse,
  type WorkflowRunResponse,
  type WorkflowTestInput,
  type WorkflowTestResponse,
  type WorkflowUpdateInput,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';
import { parseCursorPage } from '@/lib/api/parse';

/**
 * `/api/v1/workflows` and `/api/v1/workflow-catalog`, per ADR 0009's REST
 * surface (TAR-27, an amendment to 0002's endpoint table).
 *
 * Two lists with two different rules, and the difference is deliberate.
 * `GET /workflows` does **not** paginate — the set is bounded by
 * `WORKFLOW_LIMITS.workflowsPerTenant`, the evaluator loads the matching set
 * whole anyway, and 0009 fixes `nextCursor` at `null`, so handing callers a
 * cursor they can never use would only invite a paging loop that never runs.
 * `GET /workflows/{id}/runs` **does**: runs grow with ticket volume, which is
 * exactly the unbounded set the rule exists for.
 *
 * Tenant scoping is the API's, from the session cookie. There is no tenant
 * parameter here to get wrong.
 */

const WORKFLOWS_PATH = '/v1/workflows';
const WORKFLOW_CATALOG_PATH = '/v1/workflow-catalog';

export async function listWorkflows(): Promise<readonly WorkflowResponse[]> {
  const response = await authenticatedRequest({ method: 'GET', path: WORKFLOWS_PATH });

  return WorkflowListResponseSchema.parse(response).items;
}

/**
 * The trigger, condition and action vocabulary the builder's option lists come
 * from.
 *
 * Read from the API rather than imported from `@whatsappcrm/contracts`, even
 * though both are derived from the same constants: the endpoint is the one that
 * is right when this console is a version behind, because it answers with the
 * vocabulary the *server* will accept. A builder that offered an action the API
 * refuses is a refusal the supervisor cannot act on.
 */
export async function getWorkflowCatalog(): Promise<WorkflowCatalogResponse> {
  const response = await authenticatedRequest({ method: 'GET', path: WORKFLOW_CATALOG_PATH });

  return WorkflowCatalogResponseSchema.parse(response);
}

export async function createWorkflow(input: WorkflowCreateInput): Promise<WorkflowResponse> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: WORKFLOWS_PATH,
    body: input,
  });

  return WorkflowResponseSchema.parse(response);
}

export async function updateWorkflow(
  id: string,
  input: WorkflowUpdateInput,
): Promise<WorkflowResponse> {
  const response = await authenticatedRequest({
    method: 'PATCH',
    path: workflowPath(id),
    body: input,
  });

  return WorkflowResponseSchema.parse(response);
}

export async function deleteWorkflow(id: string): Promise<void> {
  await authenticatedRequest({ method: 'DELETE', path: workflowPath(id) });
}

/**
 * Rewrites `position` across the tenant's whole workflow set in one transaction.
 *
 * The payload is the complete set rather than a delta, which is also this
 * endpoint's optimistic concurrency: a set that is not exactly the tenant's
 * current one means somebody else added or removed a workflow since this page
 * loaded, and the API answers `conflict` instead of reordering half of it.
 */
export async function reorderWorkflows(
  input: WorkflowReorderInput,
): Promise<readonly WorkflowResponse[]> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: `${WORKFLOWS_PATH}/reorder`,
    body: input,
  });

  return WorkflowListResponseSchema.parse(response).items;
}

/**
 * The dry run: evaluates the workflow against one real ticket and reports what
 * *would* happen. It writes nothing — no run row, no ticket write, no
 * notification — which is what makes it safe to point at a live ticket.
 *
 * `workflow:write`, not `workflow:read`, because it reports facts about a ticket
 * the caller might not otherwise be entitled to see (0009 — `POST /test`).
 */
export async function testWorkflow(
  id: string,
  input: WorkflowTestInput,
): Promise<WorkflowTestResponse> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: `${workflowPath(id)}/test`,
    body: input,
  });

  return WorkflowTestResponseSchema.parse(response);
}

/**
 * The automation log for one workflow, newest first. "Did my rule fire, which
 * conditions held, and what did each action do" — 0009's first answer when a
 * workflow looks wrong to a supervisor, ahead of reading the definition.
 */
export async function listWorkflowRuns(
  id: string,
  { limit }: { limit: number },
): Promise<readonly WorkflowRunResponse[]> {
  const response = await authenticatedRequest({
    method: 'GET',
    path: `${workflowPath(id)}/runs?limit=${String(limit)}`,
  });

  return parseCursorPage(WorkflowRunResponseSchema, response).items;
}

function workflowPath(id: string): string {
  return `${WORKFLOWS_PATH}/${encodeURIComponent(id)}`;
}
