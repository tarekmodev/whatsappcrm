import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DateRangeField } from './DateRangeField';
import type { DateRange } from './date-range';

vi.mock('next/navigation', () => ({
  usePathname: () => '/reports',
}));

/**
 * What replacing `<input type="date">` had to keep: the platform control's
 * keyboard model, and a date a person can simply type. What it had to change:
 * the browser's own `18/07/2026`, which disagreed with every other date on the
 * dashboard.
 */
describe('DateRangeField', () => {
  const VALUE: DateRange = { from: '2026-07-18', to: '2026-08-16' };
  const TODAY = '2026-08-16';
  const PRESETS = [
    { id: 'last-7', label: 'Last 7 days', range: { from: '2026-08-10', to: TODAY } },
  ];

  function renderField(onChange = vi.fn()) {
    render(
      <DateRangeField
        label="Date range"
        value={VALUE}
        onChange={onChange}
        presets={PRESETS}
        max={TODAY}
        validate={(range) => (range.from > range.to ? 'The start date must come first' : undefined)}
      />,
    );

    return {
      onChange,
      trigger: screen.getByRole('button', { name: 'Date range: 18 Jul 2026 to 16 Aug 2026' }),
    };
  }

  it("writes the range in the workspace's format, not the browser's", () => {
    const { trigger } = renderField();

    expect(trigger).toHaveTextContent('18 Jul 2026 – 16 Aug 2026');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('applies a quick range from inside the popover and closes', () => {
    const { onChange, trigger } = renderField();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));

    expect(onChange).toHaveBeenCalledWith({ from: '2026-08-10', to: TODAY });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('takes a typed date and applies it', () => {
    const { onChange, trigger } = renderField();

    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onChange).toHaveBeenCalledWith({ from: '2026-08-01', to: '2026-08-16' });
  });

  it('explains a backwards range instead of silently clamping it', () => {
    const { onChange, trigger } = renderField();

    fireEvent.click(trigger);

    const to = screen.getByLabelText('To');

    fireEvent.change(to, { target: { value: '2026-07-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(screen.getByText('The start date must come first')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    // The caret goes to the field carrying the message rather than the button
    // going dead, which would leave the tab order and say nothing about why.
    expect(to).toHaveFocus();
  });

  it('refuses a date that is not one, rather than parsing it into a nearby month', () => {
    const { onChange, trigger } = renderField();

    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-02-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(screen.getByText('Enter both dates as YYYY-MM-DD')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is one tab stop that the arrow keys move within', () => {
    const { trigger } = renderField();

    fireEvent.click(trigger);

    const start = screen.getByRole('button', { name: 'Saturday, 18 July 2026' });

    expect(start).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'Sunday, 19 July 2026' })).toHaveAttribute(
      'tabindex',
      '-1',
    );

    start.focus();
    fireEvent.keyDown(start, { key: 'ArrowRight' });

    expect(screen.getByRole('button', { name: 'Sunday, 19 July 2026' })).toHaveFocus();
  });

  it('pages a month at a time and keeps the grid named after it', () => {
    const { trigger } = renderField();

    fireEvent.click(trigger);
    expect(screen.getByRole('grid', { name: 'July 2026, choose a date' })).toBeInTheDocument();

    const start = screen.getByRole('button', { name: 'Saturday, 18 July 2026' });

    start.focus();
    fireEvent.keyDown(start, { key: 'PageDown' });

    expect(screen.getByRole('grid', { name: 'August 2026, choose a date' })).toBeInTheDocument();
    // 18 August is past the ceiling, so the move lands on the ceiling itself
    // rather than on a day the grid will not let anybody choose.
    expect(screen.getByRole('button', { name: 'Sunday, 16 August 2026' })).toHaveFocus();
  });

  it('picks a range from two clicks in the grid', () => {
    const { onChange, trigger } = renderField();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday, 1 July 2026' }));
    fireEvent.click(screen.getByRole('button', { name: 'Friday, 10 July 2026' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onChange).toHaveBeenCalledWith({ from: '2026-07-01', to: '2026-07-10' });
  });

  it('offers no day past the ceiling it was given', () => {
    const { trigger } = renderField();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('grid', { name: 'July 2026, choose a date' }), {
      key: 'PageDown',
    });

    expect(screen.getByRole('button', { name: 'Sunday, 16 August 2026' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Monday, 17 August 2026' })).toBeDisabled();
  });

  it('drafts rather than filters: nothing is applied until Apply', () => {
    const { onChange, trigger } = renderField();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday, 1 July 2026' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('throws away the draft on Escape and returns focus to the trigger', () => {
    const { onChange, trigger } = renderField();

    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    expect(screen.getByLabelText('From')).toHaveValue('2026-07-18');
  });
});
