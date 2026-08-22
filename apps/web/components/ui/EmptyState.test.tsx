import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { TextLink } from './TextLink';

/**
 * The state anatomy TAR-515 rules, tested once here rather than on every screen
 * that renders one. What matters is what a reader gets: a name for the state, a
 * next step they can reach with a keyboard, and an icon that says nothing twice.
 */
describe('EmptyState', () => {
  it('names the state and offers its action as a real link', () => {
    render(
      <EmptyState
        icon="ticket"
        title="Nothing waiting"
        description="Tickets appear here as customers write in."
        action={<TextLink href="/tickets">View the whole queue</TextLink>}
      />,
    );

    expect(screen.getByText('Nothing waiting')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View the whole queue' })).toBeInTheDocument();
  });

  it('hides the icon from the accessibility tree, so the title says it once', () => {
    const { container } = render(<EmptyState icon="ticket" title="Nothing waiting" />);
    const icon = container.querySelector('svg');

    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    // No accessible name of its own to compete with the title.
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders no description or action when it has none to render', () => {
    render(<EmptyState icon="conversation" tone="quiet" title="Pick a conversation" />);

    expect(screen.getByText('Pick a conversation')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ErrorState', () => {
  /**
   * It has replaced the content the reader asked for, so it interrupts. The
   * politeness is deliberately not derived from whether a retry is on offer —
   * see the component, and 0001's "Every state".
   */
  it('announces itself, with or without a retry', () => {
    const { unmount } = render(<ErrorState onRetry={() => {}} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeInTheDocument();

    unmount();
    render(<ErrorState />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the correlation id the API supplied, so support can find the log line', () => {
    render(<ErrorState requestId="req-42" />);

    expect(screen.getByRole('alert')).toHaveTextContent('req-42');
  });
});
