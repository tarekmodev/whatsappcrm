import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { INDEXING_REFRESH_INTERVAL_MS } from './constants';
import { useIndexingRefresh } from './useIndexingRefresh';

const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

/**
 * `Indexing` is a transient status, and a page that only learns it has settled
 * when somebody reloads leaves an admin reading a badge that is already wrong
 * (TAR-710). What is worth pinning down is the other half: a settled knowledge
 * base must make no requests at all, and neither must a tab nobody is looking at.
 */

function Probe({ isIndexing }: { isIndexing: boolean }) {
  useIndexingRefresh(isIndexing);

  return null;
}

describe('useIndexingRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches while something is indexing', () => {
    render(<Probe isIndexing />);

    vi.advanceTimersByTime(INDEXING_REFRESH_INTERVAL_MS * 2);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('makes no request at all once nothing is pending', () => {
    render(<Probe isIndexing={false} />);

    vi.advanceTimersByTime(INDEXING_REFRESH_INTERVAL_MS * 5);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('skips a tick while the tab is hidden', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    render(<Probe isIndexing />);

    vi.advanceTimersByTime(INDEXING_REFRESH_INTERVAL_MS * 3);

    expect(refresh).not.toHaveBeenCalled();

    // The refetch is the whole state rather than a delta, so coming back catches
    // up on the next tick — nothing is owed for the ones that were skipped.
    visibility.mockReturnValue('visible');
    vi.advanceTimersByTime(INDEXING_REFRESH_INTERVAL_MS);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('stops when the table goes away', () => {
    const { unmount } = render(<Probe isIndexing />);

    unmount();
    vi.advanceTimersByTime(INDEXING_REFRESH_INTERVAL_MS * 3);

    expect(refresh).not.toHaveBeenCalled();
  });
});
