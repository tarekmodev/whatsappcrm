import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { MockModeBadge } from './MockModeBadge';

/**
 * The whole point of this component is that it is impossible to have the mock
 * transport on and not know — TAR-830 was a tester reporting a hardcoded fixture
 * as a live bug. So both branches are asserted: the flag on must produce
 * something the reader can see, and the flag off must produce nothing at all,
 * because a deployed console must not carry an empty marker element.
 */

// Hoisted so the `vi.mock` factory below, which runs before this module's
// imports are bound, can close over it and each case can set the flag.
const { env } = vi.hoisted(() => ({ env: { useMockApi: false } }));

vi.mock('@/lib/config/env', () => ({ webEnv: env }));

describe('MockModeBadge', () => {
  it('marks the screen while the mock transport is on', () => {
    env.useMockApi = true;

    render(<MockModeBadge />);

    expect(screen.getByText(content.mockNotice.label)).toBeInTheDocument();
  });

  it('says the whole fact for a screen reader, not just the two-word label', () => {
    env.useMockApi = true;

    render(<MockModeBadge />);

    expect(screen.getByText(content.mockNotice.description)).toBeInTheDocument();
  });

  it('renders nothing at all against the real API', () => {
    env.useMockApi = false;

    const { container } = render(<MockModeBadge />);

    expect(container).toBeEmptyDOMElement();
  });
});
