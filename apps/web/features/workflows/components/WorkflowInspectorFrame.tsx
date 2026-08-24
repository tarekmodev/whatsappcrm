'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import styles from './WorkflowNodeInspector.module.css';

/**
 * The panel the selected step's controls sit in. Usage:
 * `<WorkflowInspectorFrame heading={…} onRemove={…} move={…}>{fields}</WorkflowInspectorFrame>`.
 *
 * One frame for all three kinds of step, so the heading, the Remove control and
 * the move controls are positioned and labelled once. Omitting `onRemove` is how
 * a step that cannot be removed says so — the trigger, which every workflow has
 * exactly one of, and the last remaining action, which the contract requires.
 *
 * `move` is present only for actions: their order is execution order, while
 * reordering an AND changes nothing a supervisor could observe. Buttons rather
 * than drag alone, because drag is not a keyboard gesture — both land in the
 * same `moveAction`, so there is one implementation of what a move means.
 */
export interface InspectorMove {
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
}

export function WorkflowInspectorFrame({
  heading,
  children,
  onRemove,
  move,
}: {
  heading: string;
  children: ReactNode;
  onRemove?: () => void;
  move?: InspectorMove;
}) {
  const content = useContent();
  const copy = content.workflows;

  return (
    <section className={styles.panel} aria-label={copy.inspectorLabel}>
      <h3 className={styles.heading}>{heading}</h3>

      <Stack gap="3">{children}</Stack>

      {onRemove === undefined && move === undefined ? null : (
        <div className={styles.controls}>
          {move === undefined ? null : (
            <>
              <Button
                size="sm"
                disabled={move.index === 0}
                aria-label={copy.moveActionEarlierAria(move.index + 1)}
                onClick={() => {
                  move.onMove(move.index, move.index - 1);
                }}
              >
                {copy.moveActionEarlier}
              </Button>
              <Button
                size="sm"
                disabled={move.index === move.count - 1}
                aria-label={copy.moveActionLaterAria(move.index + 1)}
                onClick={() => {
                  move.onMove(move.index, move.index + 1);
                }}
              >
                {copy.moveActionLater}
              </Button>
            </>
          )}

          {onRemove === undefined ? null : (
            <Button size="sm" variant="dangerQuiet" onClick={onRemove}>
              {copy.inspectorRemove}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
