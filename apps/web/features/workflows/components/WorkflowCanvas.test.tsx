import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { content } from '@/content/en';
import { NODE_GAP, NODE_HEIGHT, toGraph, type WorkflowGraph, type WorkflowNodeId } from '../graph';
import { EMPTY_WORKFLOW_VOCABULARY } from '../presentation';
import { NO_WORKFLOW_ERRORS, type WorkflowDraft } from '../workflow-form';
import { WorkflowCanvas } from './WorkflowCanvas';

/**
 * What the renderer owes the projection: one node per step, in the order and at
 * the positions `layoutSpine` computed, with only the actions draggable and
 * nothing connectable.
 *
 * Queried through `data-testid="rf__node-{id}"`, which is React Flow's own
 * documented testing hook, rather than through its internal class names.
 *
 * ⚠️ jsdom does not lay out, so the library measures every node as zero and
 * marks it `visibility: hidden`. That is the environment, not the component: the
 * nodes are in the DOM with the right ids, positions and content, and Testing
 * Library's accessibility queries skip them. Anything about how a node *reads* is
 * therefore covered by `WorkflowNodeCard.test.tsx`, which renders the same card
 * with no library around it; this file covers the mapping.
 */

const copy = content.workflows;

const DRAFT: WorkflowDraft = {
  name: 'Escalate stale tickets',
  trigger: { type: 'ticket_created' },
  conditions: [
    { type: 'business_hours', within: false },
    { type: 'ticket_priority', operator: 'in', values: ['urgent'] },
  ],
  actions: [
    { type: 'set_status', status: 'open' },
    { type: 'set_priority', priority: 'urgent' },
    { type: 'notify', audience: 'supervisors', userId: null, teamId: null, message: null },
  ],
  isActive: false,
};

function graphOf(draft: WorkflowDraft): WorkflowGraph {
  return toGraph(draft, {
    errors: NO_WORKFLOW_ERRORS,
    references: [],
    test: null,
    vocabulary: EMPTY_WORKFLOW_VOCABULARY,
    content,
  });
}

function renderCanvas(
  overrides: Partial<Parameters<typeof WorkflowCanvas>[0]> = {},
  draft: WorkflowDraft = DRAFT,
) {
  return render(
    <WorkflowCanvas
      graph={graphOf(draft)}
      selectedNodeId={null}
      canWrite
      conditionCount={draft.conditions.length}
      actionCount={draft.actions.length}
      onSelect={vi.fn()}
      onMoveAction={vi.fn()}
      {...overrides}
    />,
  );
}

function nodeElement(container: HTMLElement, id: WorkflowNodeId): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="rf__node-${id}"]`);

  if (element === null) {
    throw new Error(`No node rendered for ${id}`);
  }

  return element;
}

describe('WorkflowCanvas', () => {
  it('renders one node per step of the projection and no others', () => {
    const { container } = renderCanvas();
    const ids = [...container.querySelectorAll('[data-id]')]
      .map((element) => element.getAttribute('data-id'))
      .filter((id) => id !== null && !id.includes('-null-'));

    expect(ids).toEqual([
      'trigger',
      'condition:0',
      'condition:1',
      'action:0',
      'action:1',
      'action:2',
    ]);
  });

  it('places each node where layoutSpine put it, top to bottom in one column', () => {
    const { container } = renderCanvas();
    const pitch = NODE_HEIGHT + NODE_GAP;

    expect(nodeElement(container, 'trigger').style.transform).toContain('translate(0px,0px)');
    expect(nodeElement(container, 'condition:0').style.transform).toContain(
      `translate(0px,${String(pitch)}px)`,
    );
    expect(nodeElement(container, 'action:0').style.transform).toContain(
      `translate(0px,${String(3 * pitch)}px)`,
    );
  });

  /**
   * Action order is execution order; reordering an AND changes nothing a
   * supervisor could observe. Offering the gesture on a condition would invite a
   * diff that means nothing.
   */
  it('makes actions draggable and leaves the trigger and conditions fixed', () => {
    const { container } = renderCanvas();

    expect(nodeElement(container, 'action:1').className).toContain('draggable');
    expect(nodeElement(container, 'condition:0').className).not.toContain('draggable');
    expect(nodeElement(container, 'trigger').className).not.toContain('draggable');
  });

  it('makes nothing draggable for a principal who may not save the result', () => {
    const { container } = renderCanvas({ canWrite: false });

    expect(nodeElement(container, 'action:1').className).not.toContain('draggable');
  });

  it('says the conditions are AND-ed with a band rather than a junction node', () => {
    const { container, queryByText } = renderCanvas();

    expect(queryByText(copy.conditionBandLabel)).toBeInTheDocument();
    // The band is not a node: it must never appear in the graph the save reads.
    expect(container.querySelectorAll('[data-testid^="rf__node-"]')).toHaveLength(6);
  });

  it('draws no band at all for a workflow with no conditions', () => {
    const { queryByText } = renderCanvas({ conditionCount: 0 }, { ...DRAFT, conditions: [] });

    expect(queryByText(copy.conditionBandLabel)).not.toBeInTheDocument();
  });

  it('names the canvas for a screen reader landing on it', () => {
    const { container } = renderCanvas();

    expect(container.querySelector('[aria-label]')).toHaveAttribute('aria-label', copy.canvasLabel);
  });

  it('reports a click on a step as a selection of that step', () => {
    const onSelect = vi.fn();
    const { container } = renderCanvas({ onSelect });
    const card = nodeElement(container, 'action:2').querySelector('button');

    fireEvent.click(card as HTMLElement);

    expect(onSelect).toHaveBeenCalledWith('action:2');
  });

  /**
   * The grammar has no edges to author — one trigger, an AND list, an ordered
   * action list — so a connectable handle could only ever express something the
   * API refuses. This is the guard that keeps the mapping total.
   */
  it('offers no way to draw, remove or reconnect an edge', () => {
    const { container } = renderCanvas();
    const handles = container.querySelectorAll('.react-flow__handle');

    expect(handles.length).toBeGreaterThan(0);
    handles.forEach((handle) => {
      expect(handle.className).not.toContain('connectionindicator');
    });
  });
});
