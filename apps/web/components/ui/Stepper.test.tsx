import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Stepper, StepperStep, STEPPER_STATUSES } from './Stepper';

/**
 * The stepper's contract with assistive technology, which is most of what it is:
 * a list with an order, one step marked current, a progress bar that says
 * something a person can use, and a status in words on every row.
 *
 * The colours are the token layer's and are not asserted here — what is asserted
 * is that nothing depends on them.
 */

function renderStepper(statuses: readonly ('done' | 'current' | 'upcoming' | 'error')[]) {
  return render(
    <Stepper
      label="Setup progress"
      resolved={1}
      total={statuses.length}
      progressLabel="1 of 4 done"
    >
      {statuses.map((status, index) => (
        <StepperStep
          key={status + String(index)}
          position={index + 1}
          status={status}
          title={`Step ${String(index + 1)}`}
          statusLabel={`Status ${status}`}
          summary={`Summary ${String(index + 1)}`}
        >
          <button type="button">Do step {index + 1}</button>
        </StepperStep>
      ))}
    </Stepper>,
  );
}

describe('Stepper', () => {
  it('is a list, so a screen reader can say which step of how many', () => {
    renderStepper(['done', 'current', 'upcoming', 'upcoming']);

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(4);
  });

  it('publishes progress as a sentence, not as a bare percentage', () => {
    renderStepper(['done', 'current', 'upcoming', 'upcoming']);

    const bar = screen.getByRole('progressbar', { name: 'Setup progress' });

    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '4');
    // "1 of 4 done" is what a person needs; "25" is what `aria-valuenow` says.
    expect(bar).toHaveAttribute('aria-valuetext', '1 of 4 done');
  });

  it('marks exactly one step current', () => {
    renderStepper(['done', 'current', 'upcoming', 'upcoming']);

    const marked = screen
      .getAllByRole('listitem')
      .filter((item) => item.getAttribute('aria-current') === 'step');

    expect(marked).toHaveLength(1);
    expect(within(marked[0]!).getByRole('heading')).toHaveTextContent('Step 2');
  });

  /** A failed step is the one the reader has to deal with, so it is the open one. */
  it('treats an errored step as the current one', () => {
    renderStepper(['done', 'error', 'upcoming', 'upcoming']);

    const errored = screen.getAllByRole('listitem')[1]!;

    expect(errored).toHaveAttribute('aria-current', 'step');
    expect(within(errored).getByRole('button', { name: 'Do step 2' })).toBeInTheDocument();
  });

  /**
   * The body belongs to the step being worked on. A done step that still has
   * something to say says it in its summary, which stays on screen — otherwise
   * every control in the flow would be in the tab order at once.
   */
  it.each(['done', 'upcoming'] as const)('keeps a %s step’s controls out of the page', (status) => {
    renderStepper([status, 'current', 'upcoming', 'upcoming']);

    expect(screen.queryByRole('button', { name: 'Do step 1' })).toBeNull();
    expect(screen.getByText('Summary 1')).toBeInTheDocument();
  });

  /** 0001: colour never carries a status on its own. */
  it.each(STEPPER_STATUSES)('says %s in words as well as in colour', (status) => {
    renderStepper([status, 'upcoming', 'upcoming', 'upcoming']);

    expect(
      within(screen.getAllByRole('listitem')[0]!).getByText(`Status ${status}`),
    ).toBeInTheDocument();
  });
});
