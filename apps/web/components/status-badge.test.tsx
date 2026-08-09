import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it('renders the label for each health status in the contract', () => {
    const { rerender } = render(<StatusBadge status="ok" />);
    expect(screen.getByRole('status')).toHaveTextContent('Operational');

    rerender(<StatusBadge status="degraded" />);
    expect(screen.getByRole('status')).toHaveTextContent('Degraded');

    rerender(<StatusBadge status="down" />);
    expect(screen.getByRole('status')).toHaveTextContent('Down');
  });

  it('exposes the raw status for styling and assertions', () => {
    render(<StatusBadge status="down" />);
    expect(screen.getByRole('status')).toHaveAttribute('data-status', 'down');
  });
});
