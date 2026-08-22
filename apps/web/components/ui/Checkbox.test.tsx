import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Checkbox } from './Checkbox';
import { CheckboxGroup } from './CheckboxGroup';

/**
 * `Checkbox` replaces the platform's painting and nothing else, so what is worth
 * asserting is that the element underneath is still a checkbox a label can
 * reach — and that `CheckboxGroup`, which now draws through it, still reports
 * the set it was toggling (TAR-710).
 */
describe('Checkbox', () => {
  it('is still a checkbox its label activates', () => {
    const onChange = vi.fn();

    render(
      <>
        <label htmlFor="weekly-summary">Send me a weekly summary</label>
        <Checkbox id="weekly-summary" onChange={onChange} />
      </>,
    );

    fireEvent.click(screen.getByLabelText('Send me a weekly summary'));

    expect(onChange).toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});

describe('CheckboxGroup', () => {
  const OPTIONS = [
    { value: 'support', label: 'Support' },
    { value: 'sales', label: 'Sales' },
  ] as const;

  it('reports the whole selection when one option is added', () => {
    const onChange = vi.fn();

    render(
      <CheckboxGroup
        legend="Teams"
        options={OPTIONS}
        selectedValues={['support']}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('Sales'));

    expect(onChange).toHaveBeenCalledWith(['support', 'sales']);
  });

  it('reports the whole selection when one option is removed', () => {
    const onChange = vi.fn();

    render(
      <CheckboxGroup
        legend="Teams"
        options={OPTIONS}
        selectedValues={['support', 'sales']}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByLabelText('Support'));

    expect(onChange).toHaveBeenCalledWith(['sales']);
  });
});
