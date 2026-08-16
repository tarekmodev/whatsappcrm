'use client';

import { useState } from 'react';
import type { WorkflowCatalogResponse, WorkflowResponse } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { useContent } from '@/lib/content';
import type { WorkflowVocabulary } from '../presentation';
import { WorkflowList, WorkflowListSkeleton } from './WorkflowList';
import { LazyWorkflowFormDialog } from './workflow-dialogs.lazy';

/**
 * The workflow section: the card, the add trigger and the list. Usage:
 * `<WorkflowsSection workflows={…} catalog={…} vocabulary={…} canWrite />`.
 *
 * `canWrite` comes from the server's permission check, so a principal holding
 * only `workflow:read` is never rendered a control that leads to a refusal.
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
  const [isAdding, setIsAdding] = useState(false);
  // The server enforces this too, with `conflict`. Disabling the control is what
  // stops a supervisor filling in the whole builder before being told.
  const isFull = workflows.length >= catalog.limits.workflowsPerTenant;

  return (
    <SectionCard
      id="workflows"
      title={copy.heading}
      description={copy.sectionDescription}
      action={
        canWrite ? (
          <Button
            variant="primary"
            disabled={isFull}
            onClick={() => {
              setIsAdding(true);
            }}
          >
            {copy.addWorkflow}
          </Button>
        ) : undefined
      }
    >
      {isFull ? (
        <Notice tone="warning">{copy.limitReachedHint(catalog.limits.workflowsPerTenant)}</Notice>
      ) : null}

      <WorkflowList
        workflows={workflows}
        catalog={catalog}
        vocabulary={vocabulary}
        canWrite={canWrite}
      />

      {isAdding ? (
        <LazyWorkflowFormDialog
          catalog={catalog}
          vocabulary={vocabulary}
          onClose={() => {
            setIsAdding(false);
          }}
        />
      ) : null}
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
