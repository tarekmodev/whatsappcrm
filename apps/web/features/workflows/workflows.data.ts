import 'server-only';

import type {
  WorkflowCatalogResponse,
  WorkflowResponse,
  WorkflowRunResponse,
} from '@whatsappcrm/contracts';
import { listTags } from '@/lib/api/contact-schema';
import { listTeams } from '@/lib/api/teams';
import { listUsers } from '@/lib/api/users';
import { listWorkflowRuns, listWorkflows, getWorkflowCatalog } from '@/lib/api/workflows';
import { WORKFLOW_RUNS_PAGE_SIZE, WORKFLOW_VOCABULARY_LIMIT } from './constants';
import type { WorkflowVocabulary } from './presentation';

/**
 * Everything the workflow surface renders: the workflows themselves, the
 * vocabulary the builder's option lists come from, and the taxonomy their
 * conditions and actions point at.
 *
 * All five reads run in parallel and all five are tenant-scoped by the API from
 * the session cookie. There is no tenant parameter here to get wrong, and no
 * read that could be widened by a query string.
 *
 * **The taxonomy is read live on every render, never cached alongside the
 * workflow.** That is TAR-27's second acceptance criterion made structural: the
 * definition stores ids, `WorkflowResponse.references` resolves them at read
 * time, and these three lists fill the pickers — so renaming a team or a tag
 * elsewhere is reflected here with nothing to republish (ADR 0009 decision 6).
 */

export interface WorkflowsData {
  readonly workflows: readonly WorkflowResponse[];
  readonly catalog: WorkflowCatalogResponse;
  readonly vocabulary: WorkflowVocabulary;
}

export async function loadWorkflows(): Promise<WorkflowsData> {
  const [workflows, catalog, teams, users, tags] = await Promise.all([
    listWorkflows(),
    getWorkflowCatalog(),
    listTeams(),
    listUsers({ limit: WORKFLOW_VOCABULARY_LIMIT }),
    listTags(),
  ]);

  return {
    workflows,
    catalog,
    vocabulary: { teams: teams.items, users: users.items, tags },
  };
}

/**
 * One workflow's recent runs — the first thing to read when a workflow looks
 * wrong, ahead of its definition (ADR 0009 — Failure modes).
 *
 * Its own read rather than part of `loadWorkflows`: it is per workflow, it is
 * asked for on demand from the run panel, and it is the one list on this surface
 * that genuinely pages.
 */
export async function loadWorkflowRuns(
  workflowId: string,
): Promise<readonly WorkflowRunResponse[]> {
  return listWorkflowRuns(workflowId, { limit: WORKFLOW_RUNS_PAGE_SIZE });
}
