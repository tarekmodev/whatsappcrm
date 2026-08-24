import { notFound } from 'next/navigation';
import { loadWorkflows } from '../workflows.data';
import { WorkflowEditor } from './WorkflowEditor';
import { WorkflowEditorSkeleton } from './WorkflowEditor.Skeleton';

/**
 * Resolves the workflow the canvas edits, then hands it and its vocabulary to
 * the editor. Usage: inside a Suspense boundary on the canvas routes, with
 * `WorkflowEditorPanelSkeleton` as the fallback.
 *
 * A server component, so the five API reads and the permission decision happen
 * on the server and the client bundle carries neither.
 *
 * **No per-id fetch.** `loadWorkflows()` already returns the tenant's whole
 * workflow set in one unpaginated read — `WorkflowListResponse.nextCursor` is
 * fixed at `null`, bounded by `workflowsPerTenant: 50` — so the edit route needs
 * no new endpoint and no new server action (TAR-809: no backend change).
 */
export async function WorkflowEditorPanel({
  workflowId = null,
  canWrite,
}: {
  /** `null` on `/settings/workflows/new`, where there is nothing to resolve. */
  workflowId?: string | null;
  canWrite: boolean;
}) {
  const { workflows, catalog, vocabulary } = await loadWorkflows();
  const workflow = workflowId === null ? null : workflows.find(({ id }) => id === workflowId);

  // A deleted workflow, or a link to one this tenant never had. An explanatory
  // 404 rather than a redirect to the list, which would hide what happened.
  if (workflowId !== null && workflow === undefined) {
    notFound();
  }

  return (
    <WorkflowEditor
      workflow={workflow ?? null}
      catalog={catalog}
      vocabulary={vocabulary}
      canWrite={canWrite}
    />
  );
}

export function WorkflowEditorPanelSkeleton() {
  return <WorkflowEditorSkeleton />;
}
