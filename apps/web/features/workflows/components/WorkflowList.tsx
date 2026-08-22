'use client';

import { useState } from 'react';
import type { WorkflowCatalogResponse, WorkflowResponse } from '@whatsappcrm/contracts';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { useContent } from '@/lib/content';
import { movedIds, type ListMoveDirection } from '@/lib/list-order';
import { WORKFLOWS_SKELETON_COUNT } from '../constants';
import type { WorkflowVocabulary } from '../presentation';
import { reorderWorkflowsAction, setWorkflowActiveAction } from '../workflows.actions';
import { WorkflowCard } from './WorkflowCard';
import { WorkflowDialogs, type OpenWorkflowDialog } from './WorkflowDialogs';
import cardStyles from './WorkflowCard.module.css';
import styles from './WorkflowList.module.css';

/**
 * The workflows in execution order, and the dialogs the row actions open. Usage:
 * `<WorkflowList workflows={…} catalog={…} vocabulary={…} canWrite />`.
 *
 * An ordered list rather than a table: the order is meaning here — two workflows
 * setting priority on the same ticket resolve the same way every time because of
 * it — `<ol>` says so to a screen reader without a column for it, and a
 * workflow's trigger, conditions and actions do not fit a cell at 320px.
 *
 * Reordering and the on/off switch write straight through — no optimistic
 * update. Both are one round trip, both can be refused (a reorder loses to a
 * concurrent edit; arming needs every reference to resolve), and an optimistic
 * reorder that rolled back would show an order that is not the one running.
 */
export function WorkflowList({
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
  const { showToast } = useToast();
  const [dialog, setDialog] = useState<OpenWorkflowDialog>(null);
  /** The workflow a write is in flight for, so only its own controls show pending. */
  const [pendingWorkflowId, setPendingWorkflowId] = useState<string | null>(null);

  /**
   * The write-toast-settle sequence the two inline actions share. A failure comes
   * back as a value, so it is shown as a toast rather than thrown into the
   * section's error boundary — a refused reorder should not blank the list.
   */
  async function runOnWorkflow(
    workflow: WorkflowResponse,
    perform: () => Promise<ActionResult<unknown>>,
    describeSuccess: () => string,
  ): Promise<void> {
    setPendingWorkflowId(workflow.id);

    try {
      const result = await perform();

      showToast(
        result.status === 'success'
          ? { tone: 'success', message: describeSuccess() }
          : { tone: 'danger', message: result.message },
      );
    } finally {
      setPendingWorkflowId(null);
    }
  }

  function move(workflow: WorkflowResponse, direction: ListMoveDirection): void {
    // A second move started before the first came back would be computed from
    // the pre-move order, and the endpoint cannot catch it: both payloads carry
    // the same members, so its concurrency check passes both and the later write
    // silently undoes the earlier one. The cards disable the controls too; this
    // is the guard that does not depend on them.
    if (pendingWorkflowId !== null) {
      return;
    }

    const workflowIds = movedIds(
      workflows.map((current) => current.id),
      workflow.id,
      direction,
    );

    // `null` means it is already at that end, which the card's disabled control
    // should have prevented — sending the unchanged order would do nothing.
    if (workflowIds === null) {
      return;
    }

    void runOnWorkflow(
      workflow,
      () => reorderWorkflowsAction({ workflowIds: [...workflowIds] }),
      () => copy.reorderSuccess,
    );
  }

  function toggle(workflow: WorkflowResponse): void {
    void runOnWorkflow(
      workflow,
      () => setWorkflowActiveAction(workflow.id, !workflow.isActive),
      () =>
        workflow.isActive ? copy.disableSuccess(workflow.name) : copy.enableSuccess(workflow.name),
    );
  }

  if (workflows.length === 0) {
    return <EmptyState icon="automation" title={copy.emptyHeading} description={copy.emptyBody} />;
  }

  return (
    <>
      <ol className={styles.list} aria-label={copy.listLabel}>
        {workflows.map((workflow, index) => (
          <WorkflowCard
            key={workflow.id}
            workflow={workflow}
            position={index + 1}
            vocabulary={vocabulary}
            canWrite={canWrite}
            isFirst={index === 0}
            isLast={index === workflows.length - 1}
            isPending={pendingWorkflowId === workflow.id}
            isReordering={pendingWorkflowId !== null}
            onMove={(direction) => {
              move(workflow, direction);
            }}
            onToggle={() => {
              toggle(workflow);
            }}
            onEdit={() => {
              setDialog({ kind: 'edit', workflow });
            }}
            onTest={() => {
              setDialog({ kind: 'test', workflow });
            }}
            onViewRuns={() => {
              setDialog({ kind: 'runs', workflow });
            }}
            onDelete={() => {
              setDialog({ kind: 'delete', workflow });
            }}
          />
        ))}
      </ol>

      <WorkflowDialogs
        dialog={dialog}
        catalog={catalog}
        vocabulary={vocabulary}
        onClose={() => {
          setDialog(null);
        }}
      />
    </>
  );
}

/**
 * Mirrors the loaded list: the same `<ol>`, the same card frame and spacing, a
 * name line, a trigger line, two condition lines and an action line — so the
 * swap to real workflows shifts nothing. The action row is included only where
 * the role will get one.
 */
export function WorkflowListSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.workflows.loading} />
      <ol className={styles.list}>
        {Array.from({ length: WORKFLOWS_SKELETON_COUNT }, (_unused, index) => (
          <li key={index} className={cardStyles.card} aria-hidden="true">
            <SkeletonLine width="6rem" height="var(--font-size-caption)" />
            <SkeletonLine width="12rem" height="1.125rem" />
            <SkeletonLine width="10rem" />
            <SkeletonText lines={2} />
            <SkeletonLine width="14rem" />
            {hasActions ? <SkeletonLine height="var(--size-touch-target)" /> : null}
          </li>
        ))}
      </ol>
    </>
  );
}
