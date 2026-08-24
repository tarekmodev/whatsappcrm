'use client';

import type { WorkflowResponse } from '@whatsappcrm/contracts';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { ClauseList } from '@/components/ui/ClauseList';
import { Notice } from '@/components/ui/Notice';
import { useContent } from '@/lib/content';
import type { ListMoveDirection } from '@/lib/list-order';
import { routes } from '@/lib/routes';
import {
  createReferenceLookup,
  describeAction,
  describeBrokenReferences,
  describeCondition,
  describeTrigger,
  type WorkflowVocabulary,
} from '../presentation';
import styles from './WorkflowCard.module.css';

/**
 * One workflow in the list: when it runs, what it checks, what it does, and the
 * controls that change any of that. Usage: rendered by `WorkflowList` per
 * workflow.
 *
 * Every control is a real button whose accessible name includes the workflow —
 * "Turn on Escalate stale tickets", not "Turn on" — because a screen-reader user
 * tabbing a list of five hears the names, not the rows.
 *
 * `canWrite` removes the controls entirely rather than disabling them: a
 * supervisor with read-only access is shown the workflows, not six dead buttons.
 */
export function WorkflowCard({
  workflow,
  position,
  vocabulary,
  canWrite,
  isFirst,
  isLast,
  isPending,
  isReordering,
  onMove,
  onToggle,
  onTest,
  onViewRuns,
  onDelete,
}: {
  workflow: WorkflowResponse;
  /** One-based place in the execution order, shown to the user. */
  position: number;
  vocabulary: WorkflowVocabulary;
  canWrite: boolean;
  isFirst: boolean;
  isLast: boolean;
  /** True while any mutation on this workflow is in flight. */
  isPending: boolean;
  /**
   * True while a write on *any* workflow is in flight. A move is computed from
   * the order on screen, which does not update until revalidation lands, so a
   * second move started before the first returns would be computed from the
   * stale order and overwrite it. Every row's move controls stand down together.
   */
  isReordering: boolean;
  onMove: (direction: ListMoveDirection) => void;
  onToggle: () => void;
  onTest: () => void;
  onViewRuns: () => void;
  onDelete: () => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const names = createReferenceLookup(workflow.references, vocabulary);
  const broken = describeBrokenReferences(workflow.references, content);
  // `brokenReason` is **derived state, not a latch** (ADR 0009 decision 6, as
  // amended on TAR-399): the API arms on reference resolution alone and says so —
  // the field is "safe to render and safe to ignore as a gate". Reading it as
  // sticky here disagreed with that gate. A removed agent is re-invited onto the
  // same row, so the id resolves again while the stored column still stands until
  // the next write, and the workflow could never be turned back on.
  const isBroken = broken.length > 0;

  return (
    <li className={styles.card} data-inactive={workflow.isActive ? undefined : 'true'}>
      <Cluster justify="between" align="start" gap="3">
        <div className={styles.identity}>
          <p className={styles.position}>{copy.orderPosition(position)}</p>
          <h3 className={styles.name}>{workflow.name}</h3>
        </div>
        <Badge tone={workflow.isActive ? 'success' : 'neutral'}>
          {workflow.isActive ? copy.active : copy.inactive}
        </Badge>
      </Cluster>

      {isBroken ? (
        <Notice tone="warning">
          {workflow.brokenReason === null
            ? copy.brokenBody(broken.join(', '))
            : `${copy.brokenReasons[workflow.brokenReason]} ${copy.brokenBody(broken.join(', '))}`}
        </Notice>
      ) : null}

      <Stack gap="2">
        <p className={styles.label}>{copy.triggerHeading}</p>
        <p className={styles.clause}>{describeTrigger(workflow.trigger, content)}</p>
      </Stack>

      <Stack gap="2">
        <p className={styles.label}>{copy.conditionsHeading}</p>
        {workflow.conditions.length === 0 ? (
          <p className={styles.clause} data-muted="true">
            {copy.alwaysMatches}
          </p>
        ) : (
          <ClauseList
            clauses={workflow.conditions.map((condition) =>
              describeCondition(condition, names, content),
            )}
          />
        )}
      </Stack>

      <Stack gap="2">
        <p className={styles.label}>{copy.actionsHeading}</p>
        <ClauseList
          clauses={workflow.actions.map((action) => describeAction(action, names, content))}
        />
      </Stack>

      {canWrite ? (
        <Cluster gap="2" className={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            // `isPending` rather than `disabled` on the row that was actually
            // clicked: `disabled` drops the button out of the tab order, so a
            // keyboard user who pressed this one would lose their place the
            // instant it fired.
            disabled={isFirst || (isReordering && !isPending)}
            isPending={isPending}
            aria-label={copy.moveUpAria(workflow.name)}
            onClick={() => {
              onMove('up');
            }}
          >
            {copy.moveUp}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={isLast || (isReordering && !isPending)}
            isPending={isPending}
            aria-label={copy.moveDownAria(workflow.name)}
            onClick={() => {
              onMove('down');
            }}
          >
            {copy.moveDown}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            // A broken workflow cannot be armed: the API answers
            // `workflow_reference_broken`, and the notice above already says what
            // to replace. Turning one *off* stays available whatever its state.
            disabled={!workflow.isActive && isBroken}
            isPending={isPending}
            aria-label={
              workflow.isActive ? copy.disableAria(workflow.name) : copy.enableAria(workflow.name)
            }
            title={!workflow.isActive && isBroken ? copy.brokenCannotEnable : undefined}
            onClick={onToggle}
          >
            {workflow.isActive ? copy.disable : copy.enable}
          </Button>
          {/*
            A link, not a button: editing is a navigation to the canvas route
            now, so middle-click, copy-link and the status bar all work — and the
            back button returns to this list. The name it reads out is the same
            one the other controls use, so a row of five does not read as five
            identical "Edit"s.
          */}
          <ButtonLink
            href={routes.settingsWorkflow(workflow.id)}
            variant="secondary"
            size="sm"
            ariaLabel={copy.editWorkflowAria(workflow.name)}
          >
            {copy.editWorkflow}
          </ButtonLink>
          <Button
            variant="ghost"
            size="sm"
            aria-label={copy.testWorkflowAria(workflow.name)}
            onClick={onTest}
          >
            {copy.testWorkflow}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={copy.viewRunsAria(workflow.name)}
            onClick={onViewRuns}
          >
            {copy.viewRuns}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={copy.deleteWorkflowAria(workflow.name)}
            onClick={onDelete}
          >
            {copy.deleteWorkflow}
          </Button>
        </Cluster>
      ) : null}
    </li>
  );
}
