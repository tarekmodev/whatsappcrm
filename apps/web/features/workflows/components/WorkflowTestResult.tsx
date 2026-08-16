'use client';

import type { WorkflowResponse, WorkflowTestResponse } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { Badge } from '@/components/ui/Badge';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { Notice } from '@/components/ui/Notice';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import styles from './WorkflowTestResult.module.css';

/**
 * What a dry run reported: whether the workflow would run, which conditions
 * held, and what each action would do. Usage: rendered by `TestWorkflowDialog`
 * once a result arrives.
 *
 * Every row carries its verdict in text as well as in a badge tone, because a
 * result read out by a screen reader has no colour to lean on — and "held" next
 * to a clause is the whole answer a supervisor came for.
 */
export function WorkflowTestResult({ result }: { result: WorkflowTestResponse }) {
  const content = useContent();
  const copy = content.workflows;

  return (
    <div className={styles.result}>
      <Notice tone={result.matched ? 'info' : 'warning'}>
        {result.matched ? copy.testMatched : copy.testNotMatched}
      </Notice>

      <Stack gap="2">
        <p className={styles.heading}>{copy.testConditionsHeading}</p>
        {result.conditions.length === 0 ? (
          <p className={styles.rowText}>{copy.testNoConditions}</p>
        ) : (
          <ul className={styles.rows}>
            {result.conditions.map((condition) => (
              <li key={condition.index} className={styles.row}>
                <Badge tone={condition.held ? 'success' : 'neutral'}>
                  {condition.held ? copy.testHeld : copy.testNotHeld}
                </Badge>
                <span className={styles.rowText}>
                  {copy.conditionTypes[condition.type]}
                  {condition.reason === null ? null : (
                    <span className={styles.reason}> — {condition.reason}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Stack>

      <Stack gap="2">
        <p className={styles.heading}>{copy.testActionsHeading}</p>
        {result.actions.length === 0 ? (
          <p className={styles.rowText}>{copy.testNoActions}</p>
        ) : (
          <ul className={styles.rows}>
            {result.actions.map((action) => (
              <li key={action.index} className={styles.row}>
                <Badge tone={action.outcome === 'applied' ? 'accent' : 'neutral'}>
                  {copy.actionOutcomes[action.outcome]}
                </Badge>
                {/* `describes` is the API's own resolved sentence — "Reassign to
                    team Escalations" — so a name that changed since the workflow
                    was written reads correctly without a second lookup here. */}
                <span className={styles.rowText}>{action.describes}</span>
              </li>
            ))}
          </ul>
        )}
      </Stack>
    </div>
  );
}

/**
 * Mirrors the loaded result: the same notice band, the same two labelled groups
 * and the same row count as a workflow of this size will produce — so the swap
 * from checking to checked shifts nothing.
 */
export function WorkflowTestResultSkeleton({ workflow }: { workflow: WorkflowResponse }) {
  const content = useContent();

  return (
    <>
      {/* Outside the `aria-hidden` wrapper, or the one announcement a skeleton
          is allowed would be hidden along with the placeholders. */}
      <LoadingAnnouncement label={content.workflows.testLoading} />
      <div className={styles.result} aria-hidden="true">
        <SkeletonLine height="var(--size-control-md)" />
        <Stack gap="2">
          <SkeletonLine width="6rem" height="var(--font-size-caption)" />
          <SkeletonText lines={Math.max(workflow.conditions.length, 1)} />
        </Stack>
        <Stack gap="2">
          <SkeletonLine width="8rem" height="var(--font-size-caption)" />
          <SkeletonText lines={workflow.actions.length} />
        </Stack>
      </div>
    </>
  );
}
