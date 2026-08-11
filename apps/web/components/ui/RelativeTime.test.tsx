import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RelativeTime } from './RelativeTime';

/**
 * The unit is picked from the distance to now, in both directions: the inbox
 * renders timestamps in the past and the invitation screen renders one in the
 * future, and a signed comparison sent the future case straight to seconds.
 */
const NOW = new Date('2026-08-11T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function renderAt(isoTimestamp: string): string {
  const { container } = render(<RelativeTime isoTimestamp={isoTimestamp} label="Expires" />);

  return container.querySelector('time')?.textContent ?? '';
}

describe('RelativeTime', () => {
  it('renders a past timestamp in the largest sensible unit', () => {
    expect(renderAt('2026-08-08T12:00:00.000Z')).toBe('3 days ago');
  });

  it('renders a future timestamp in days, not in seconds', () => {
    expect(renderAt('2026-08-18T12:00:00.000Z')).toBe('in 7 days');
  });

  it('still uses minutes for something a few minutes out', () => {
    expect(renderAt('2026-08-11T12:20:00.000Z')).toBe('in 20 minutes');
  });

  it('keeps the machine-readable value on the element', () => {
    render(<RelativeTime isoTimestamp="2026-08-18T12:00:00.000Z" label="Expires" />);

    expect(screen.getByText('in 7 days')).toHaveAttribute('datetime', '2026-08-18T12:00:00.000Z');
  });
});
