import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SearchField } from './SearchField';

/**
 * The three things 0001's filter row asks of a search box: it is labelled even
 * when the label is not drawn, it can be emptied without selecting the text, and
 * emptying it leaves the caret where more can be typed.
 */
describe('SearchField', () => {
  it('is labelled for a screen reader without drawing the label', () => {
    render(<SearchField label="Search agents" value="" onChange={vi.fn()} />);

    expect(screen.getByRole('searchbox', { name: 'Search agents' })).toBeInTheDocument();
  });

  it('offers no clear affordance until there is something to clear', () => {
    const { rerender } = render(<SearchField label="Search agents" value="" onChange={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();

    rerender(<SearchField label="Search agents" value="ada" onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
  });

  it('clears the box and hands focus back to it', () => {
    const onChange = vi.fn();

    render(<SearchField label="Search agents" value="ada" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.getByRole('searchbox', { name: 'Search agents' })).toHaveFocus();
  });
});
