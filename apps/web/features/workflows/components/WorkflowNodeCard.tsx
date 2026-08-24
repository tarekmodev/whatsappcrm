'use client';

import type { WorkflowGraphNode } from '../graph';
import { Badge } from '@/components/ui/Badge';
import { useContent } from '@/lib/content';
import styles from './WorkflowNodeCard.module.css';

/**
 * One step on the workflow canvas. Usage:
 * `<WorkflowNodeCard node={node} isSelected={…} onSelect={…} />`.
 *
 * **It knows nothing about the canvas library.** It takes a `WorkflowGraphNode`
 * — `graph.ts`'s own model — and renders a box of a fixed size. That is what
 * lets the same component stand in three places without drifting: inside the
 * renderer's custom node, inside the canvas skeleton, and inside the read-only
 * spine that replaces the canvas below the breakpoint where a viewport with
 * pan and zoom stops being usable.
 *
 * A `<button>`, so a keyboard reaches every step and opens its inspector without
 * the library having to make it so. The card is a *summary*: the sentence comes
 * from `presentation.ts` and the detail lives in the inspector beside it.
 */
export function WorkflowNodeCard({
  node,
  isSelected,
  onSelect,
}: {
  node: WorkflowGraphNode;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const content = useContent();
  const copy = content.workflows;
  const kind = copy.nodeKinds[node.kind];

  return (
    <button
      type="button"
      className={styles.card}
      data-selected={isSelected ? 'true' : undefined}
      data-invalid={node.error === null ? undefined : 'true'}
      data-node-kind={node.kind}
      aria-current={isSelected ? 'true' : undefined}
      aria-label={copy.nodeSelectAria(kind, node.summary)}
      onClick={onSelect}
    >
      <span className={styles.head}>
        <span className={styles.kind}>{kind}</span>
        {node.index === null ? null : <span className={styles.kind}>{String(node.index + 1)}</span>}
      </span>

      <span className={styles.summary}>{node.summary}</span>

      <WorkflowNodeMarks node={node} />
    </button>
  );
}

/**
 * The badges a step carries: what validation says, what no longer resolves, and
 * what the last dry run found.
 *
 * Extracted because the skeleton needs the row's *height* without its content —
 * the marks row is what makes the card the same height empty as full, so the
 * swap from placeholder to real step shifts nothing.
 */
function WorkflowNodeMarks({ node }: { node: WorkflowGraphNode }) {
  const content = useContent();
  const copy = content.workflows;

  return (
    <span className={styles.marks}>
      {node.error === null ? null : (
        <Badge tone="danger" size="sm">
          {copy.nodeNeedsAttention}
        </Badge>
      )}

      {node.brokenReferences.length === 0 ? null : (
        <Badge tone="warning" size="sm">
          {copy.nodeBrokenReference(node.brokenReferences.length)}
        </Badge>
      )}

      {node.testResult === null ? null : <WorkflowNodeTestMark result={node.testResult} />}
    </span>
  );
}

function WorkflowNodeTestMark({
  result,
}: {
  result: NonNullable<WorkflowGraphNode['testResult']>;
}) {
  const content = useContent();
  const copy = content.workflows;

  if (result.kind === 'condition') {
    // A reason means the API could not judge it either way, which is neither
    // held nor not held — saying "did not hold" would report a verdict nobody
    // reached.
    if (result.reason !== null) {
      return (
        <Badge tone="warning" size="sm">
          {copy.dryRunCouldNotEvaluate}
        </Badge>
      );
    }

    return (
      <Badge tone={result.held ? 'success' : 'neutral'} size="sm">
        {result.held ? copy.testHeld : copy.testNotHeld}
      </Badge>
    );
  }

  return (
    <Badge tone={result.outcome === 'applied' ? 'success' : 'neutral'} size="sm">
      {copy.actionOutcomes[result.outcome]}
    </Badge>
  );
}
