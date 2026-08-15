'use server';

import {
  WorkflowCreateInputSchema,
  WorkflowReorderInputSchema,
  WorkflowTestInputSchema,
  WorkflowUpdateInputSchema,
  type WorkflowRunResponse,
  type WorkflowTestResponse,
} from '@whatsappcrm/contracts';
import {
  createWorkflow,
  deleteWorkflow,
  reorderWorkflows,
  testWorkflow,
  updateWorkflow,
} from '@/lib/api/workflows';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import { runAction } from '@/lib/actions/run-action';
import { loadWorkflowRuns } from './workflows.data';

/**
 * Mutations for the workflow surface. Each asserts the permission ADR 0009
 * assigns the endpoint, validates against the contract's own schema, and comes
 * back as a value rather than a throw; `runAction` owns that sequence.
 *
 * There is nothing here beyond it, on purpose. Every rule about a workflow — one
 * trigger, conditions that combine with AND, an action list of one to five, a
 * reorder that is the whole set, no arming a workflow whose references are
 * broken — is expressed in the contract or enforced by the API, so this module
 * has no invariant of its own to restate and get subtly wrong.
 */

/** The surface these mutations re-render. `settingsWorkflows()` takes no query. */
const WORKFLOWS_PATH = routes.settingsWorkflows();

const ACTION_LABEL = 'Workflows';

export async function createWorkflowAction(
  input: unknown,
): Promise<ActionResult<{ name: string }>> {
  return runAction({
    permission: 'workflow:write',
    parser: WorkflowCreateInputSchema,
    input,
    revalidate: WORKFLOWS_PATH,
    label: ACTION_LABEL,
    perform: async (parsed) => {
      const workflow = await createWorkflow(parsed);

      return { name: workflow.name };
    },
  });
}

export async function updateWorkflowAction(
  workflowId: string,
  input: unknown,
): Promise<ActionResult<{ name: string }>> {
  return runAction({
    permission: 'workflow:write',
    parser: WorkflowUpdateInputSchema,
    input,
    revalidate: WORKFLOWS_PATH,
    label: ACTION_LABEL,
    perform: async (parsed) => {
      const workflow = await updateWorkflow(workflowId, parsed);

      return { name: workflow.name };
    },
  });
}

/**
 * The arm/disarm switch. A `PATCH` like any other, so a workflow whose
 * references no longer resolve is refused with `workflow_reference_broken` and
 * copy naming what to replace — the console disables the control as well, but
 * the refusal is what makes it safe.
 */
export async function setWorkflowActiveAction(
  workflowId: string,
  isActive: boolean,
): Promise<ActionResult<{ name: string; isActive: boolean }>> {
  return runAction({
    permission: 'workflow:write',
    parser: WorkflowUpdateInputSchema,
    input: { isActive },
    revalidate: WORKFLOWS_PATH,
    label: ACTION_LABEL,
    perform: async (parsed) => {
      const workflow = await updateWorkflow(workflowId, parsed);

      return { name: workflow.name, isActive: workflow.isActive };
    },
  });
}

export async function deleteWorkflowAction(
  workflowId: string,
  name: string,
): Promise<ActionResult<{ name: string }>> {
  return runAction({
    permission: 'workflow:write',
    parser: null,
    input: undefined,
    revalidate: WORKFLOWS_PATH,
    label: ACTION_LABEL,
    perform: async () => {
      await deleteWorkflow(workflowId);

      return { name };
    },
  });
}

export async function reorderWorkflowsAction(
  input: unknown,
): Promise<ActionResult<{ count: number }>> {
  return runAction({
    permission: 'workflow:write',
    parser: WorkflowReorderInputSchema,
    input,
    revalidate: WORKFLOWS_PATH,
    label: ACTION_LABEL,
    perform: async (parsed) => {
      const workflows = await reorderWorkflows(parsed);

      return { count: workflows.length };
    },
  });
}

/**
 * The dry run. `workflow:write` rather than `workflow:read`, matching the
 * endpoint: it reports facts about one ticket, and reporting them to somebody
 * whose ticket scope does not reach it would be a read-scope bypass.
 *
 * `revalidate: null` — it writes nothing, so there is nothing to invalidate, and
 * re-rendering the list behind an open dialog would only make it flicker.
 */
export async function testWorkflowAction(
  workflowId: string,
  input: unknown,
): Promise<ActionResult<WorkflowTestResponse>> {
  return runAction({
    permission: 'workflow:write',
    parser: WorkflowTestInputSchema,
    input,
    revalidate: null,
    label: ACTION_LABEL,
    perform: async (parsed) => testWorkflow(workflowId, parsed),
  });
}

/**
 * The run log, read on demand from the run panel.
 *
 * An action rather than a server component because the panel opens from a click
 * in a client component that has no server render of its own to hang the read
 * off — the same shape the composer's template picker uses. `workflow:read`, and
 * it reads only.
 */
export async function listWorkflowRunsAction(
  workflowId: string,
): Promise<ActionResult<readonly WorkflowRunResponse[]>> {
  return runAction({
    permission: 'workflow:read',
    parser: null,
    input: undefined,
    revalidate: null,
    label: ACTION_LABEL,
    perform: async () => loadWorkflowRuns(workflowId),
  });
}
