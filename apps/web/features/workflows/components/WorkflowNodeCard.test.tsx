import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import type { WorkflowGraphNode } from '../graph';
import { WorkflowNodeCard } from './WorkflowNodeCard';

/**
 * The card is where a step stops being data and becomes something a supervisor
 * can read and reach. Three things have to be true of it and none is polish:
 * every step is operable from the keyboard, its accessible name says *which*
 * step it is, and every mark it carries says its meaning in words rather than in
 * colour alone.
 */

const copy = content.workflows;

function node(overrides: Partial<WorkflowGraphNode> = {}): WorkflowGraphNode {
  return {
    id: 'condition:0',
    kind: 'condition',
    index: 0,
    position: { x: 0, y: 128 },
    summary: 'it is inside business hours',
    error: null,
    brokenReferences: [],
    testResult: null,
    ...overrides,
  };
}

describe('WorkflowNodeCard', () => {
  it('is a button whose name says which step it is, not just "edit"', () => {
    const onSelect = vi.fn();

    render(<WorkflowNodeCard node={node()} isSelected={false} onSelect={onSelect} />);

    const card = screen.getByRole('button', {
      name: copy.nodeSelectAria(copy.nodeKinds.condition, 'it is inside business hours'),
    });

    fireEvent.click(card);

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('marks the selected step for assistive technology as well as visually', () => {
    const { rerender } = render(
      <WorkflowNodeCard node={node()} isSelected={false} onSelect={vi.fn()} />,
    );

    expect(screen.getByRole('button')).not.toHaveAttribute('aria-current');

    rerender(<WorkflowNodeCard node={node()} isSelected onSelect={vi.fn()} />);

    expect(screen.getByRole('button')).toHaveAttribute('aria-current', 'true');
  });

  it('says a step needs attention in words, not only by turning its border red', () => {
    render(
      <WorkflowNodeCard
        node={node({ error: copy.tagsRequiredError })}
        isSelected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(copy.nodeNeedsAttention)).toBeInTheDocument();
  });

  it('counts the missing references a step names, so two removed tags read as two', () => {
    render(
      <WorkflowNodeCard
        node={node({
          brokenReferences: [
            { kind: 'tag', id: 'a', name: null, exists: false },
            { kind: 'tag', id: 'b', name: null, exists: false },
          ],
        })}
        isSelected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(copy.nodeBrokenReference(2))).toBeInTheDocument();
  });

  /**
   * A condition the API could not judge is neither held nor not held. Reporting
   * it as "did not hold" would put a verdict on the node that nobody reached,
   * and a supervisor would go looking for a condition that is not wrong.
   */
  it('separates "did not hold" from "could not be checked"', () => {
    const { rerender } = render(
      <WorkflowNodeCard
        node={node({ testResult: { kind: 'condition', held: false, reason: null } })}
        isSelected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(copy.testNotHeld)).toBeInTheDocument();

    rerender(
      <WorkflowNodeCard
        node={node({
          testResult: { kind: 'condition', held: false, reason: 'business_hours_unconfigured' },
        })}
        isSelected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(copy.dryRunCouldNotEvaluate)).toBeInTheDocument();
    expect(screen.queryByText(copy.testNotHeld)).not.toBeInTheDocument();
  });

  it('reports what a dry run said an action would do, in the API’s own words', () => {
    render(
      <WorkflowNodeCard
        node={node({
          id: 'action:0',
          kind: 'action',
          testResult: {
            kind: 'action',
            outcome: 'no_op',
            describes: 'Set status to open',
          },
        })}
        isSelected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText(copy.actionOutcomes.no_op)).toBeInTheDocument();
  });

  it('numbers a step from one, and gives the trigger no number at all', () => {
    const { rerender } = render(
      <WorkflowNodeCard node={node({ index: 2 })} isSelected={false} onSelect={vi.fn()} />,
    );

    expect(screen.getByText('3')).toBeInTheDocument();

    rerender(
      <WorkflowNodeCard
        node={node({ id: 'trigger', kind: 'trigger', index: null })}
        isSelected={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByText('3')).not.toBeInTheDocument();
    expect(screen.getByText(copy.nodeKinds.trigger)).toBeInTheDocument();
  });
});
