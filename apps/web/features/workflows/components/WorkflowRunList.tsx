'use client';

import type { WorkflowRunResponse } from '@whatsappcrm/contracts';
import { Cluster } from '@/components/layout/Cluster';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { WORKFLOW_RUNS_SKELETON_COUNT } from '../constants';
import styles from './WorkflowRunList.module.css';

/**
 * The automation log for one workflow, newest first. Usage: rendered by
 * `WorkflowRunsDialog` once the runs arrive.
 *
 * `skipped` is given the same weight as `succeeded` rather than being hidden,
 * because "it ran and its conditions did not match" is the answer to half the
 * questions that bring a supervisor here — and a log that only showed the runs
 * that did something would look like a workflow that never fires.
 */
export function WorkflowRunList({ runs }: { runs: readonly WorkflowRunResponse[] }) {
  const content = useContent();
  const copy = content.workflows;

  if (runs.length === 0) {
    return (
      <EmptyState
        icon="automation"
        title={copy.runsEmptyHeading}
        description={copy.runsEmptyBody}
      />
    );
  }

  return (
    <ul className={styles.list}>
      {runs.map((run) => (
        <li key={run.id} className={styles.run}>
          <Cluster justify="between" align="start" gap="2">
            <p className={styles.ticket}>{copy.runTicket(run.ticketNumber)}</p>
            <Badge tone={runTone(run)}>{copy.runStatuses[run.status]}</Badge>
          </Cluster>

          <p className={styles.detail}>
            {copy.triggerTypes[run.triggerType]} ·{' '}
            <RelativeTime isoTimestamp={run.createdAt} label={copy.runsTitle(copy.heading)} />
          </p>

          {run.failureReason === null ? null : (
            <p className={styles.detail}>{copy.failureReasons[run.failureReason]}</p>
          )}

          {run.results.length === 0 ? (
            <p className={styles.detail}>{copy.runNothingAttempted}</p>
          ) : (
            <ul className={styles.results}>
              {run.results.map((result) => (
                <li key={result.index} className={styles.result}>
                  <Badge tone={result.outcome === 'failed' ? 'danger' : 'neutral'}>
                    {copy.actionOutcomes[result.outcome]}
                  </Badge>
                  <span>{copy.actionTypes[result.type]}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Mirrors the loaded list: the same card frame, a ticket line, a trigger line
 * and two result lines, so the swap shifts nothing.
 */
export function WorkflowRunListSkeleton() {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.workflows.runsLoading} />
      <ul className={styles.list} aria-hidden="true">
        {Array.from({ length: WORKFLOW_RUNS_SKELETON_COUNT }, (_unused, index) => (
          <li key={index} className={styles.run}>
            <SkeletonLine width="8rem" height="1.125rem" />
            <SkeletonLine width="12rem" height="var(--font-size-caption)" />
            <SkeletonText lines={2} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Tone follows the outcome, and the label always carries it in words as well —
 * a run list read out by a screen reader has no colour to lean on.
 */
function runTone(run: WorkflowRunResponse): BadgeTone {
  switch (run.status) {
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'danger';
    case 'skipped':
      return 'neutral';
    case 'pending':
    case 'running':
      return 'info';
  }
}
