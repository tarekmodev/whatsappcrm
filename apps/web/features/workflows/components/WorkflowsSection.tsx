import type { WorkflowCatalogResponse, WorkflowResponse } from '@whatsappcrm/contracts';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import type { WorkflowVocabulary } from '../presentation';
import { WorkflowList, WorkflowListSkeleton } from './WorkflowList';

/**
 * The workflow section: the card, the add control and the list. Usage:
 * `<WorkflowsSection workflows={…} catalog={…} vocabulary={…} canWrite />`.
 *
 * `canWrite` comes from the server's permission check, so a principal holding
 * only `workflow:read` is never rendered a control that leads to a refusal.
 *
 * Adding is a **link to the canvas route** rather than a dialog it opens, which
 * is what let this component go back to the server: it holds no state now, so
 * the whole section renders on the server and only the list — which owns the
 * on/off switch and the reorder — ships as client code.
 */
export function WorkflowsSection({
  workflows,
  catalog,
  vocabulary,
  canWrite,
}: {
  workflows: readonly WorkflowResponse[];
  catalog: WorkflowCatalogResponse;
  vocabulary: WorkflowVocabulary;
  canWrite: boolean;
}) {
  const content = useContent();
  const copy = content.workflows;
  // The server enforces this too, with `conflict`. Standing the control down is
  // what stops a supervisor building a whole workflow before being told.
  const isFull = workflows.length >= catalog.limits.workflowsPerTenant;

  return (
    <SectionCard
      id="workflows"
      title={copy.heading}
      description={copy.sectionDescription}
      action={
        canWrite && !isFull ? (
          <ButtonLink href={routes.settingsWorkflowNew()} variant="primary">
            {copy.addWorkflow}
          </ButtonLink>
        ) : undefined
      }
    >
      {isFull ? (
        <Notice tone="warning">{copy.limitReachedHint(catalog.limits.workflowsPerTenant)}</Notice>
      ) : null}

      <WorkflowList workflows={workflows} vocabulary={vocabulary} canWrite={canWrite} />
    </SectionCard>
  );
}

/** Mirrors the section's frame, with the list's own skeleton inside it. */
export function WorkflowsSectionSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  const content = useContent();

  return (
    <SectionCard
      id="workflows"
      title={content.workflows.heading}
      description={content.workflows.sectionDescription}
    >
      <WorkflowListSkeleton hasActions={hasActions} />
    </SectionCard>
  );
}
