import { loadWorkflows } from '../workflows.data';
import { WorkflowsSection, WorkflowsSectionSkeleton } from './WorkflowsSection';

/**
 * Fetches the workflows, the catalog and the taxonomy, then hands all three to
 * the section. Usage: inside its own Suspense boundary on the Workflows page,
 * with `WorkflowsPanelSkeleton` as the fallback.
 *
 * A server component, so five API reads and the permission decision happen on
 * the server and the client bundle carries neither.
 */
export async function WorkflowsPanel({ canWrite }: { canWrite: boolean }) {
  const { workflows, catalog, vocabulary } = await loadWorkflows();

  return (
    <WorkflowsSection
      workflows={workflows}
      catalog={catalog}
      vocabulary={vocabulary}
      canWrite={canWrite}
    />
  );
}

export function WorkflowsPanelSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  return <WorkflowsSectionSkeleton hasActions={hasActions} />;
}
