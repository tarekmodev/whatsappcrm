import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFilterNavigation } from './useFilterNavigation';

/**
 * The race the three filter bars used to share (TAR-780): `useSearchParams`
 * reflects the URL that has **landed**, so a navigation computed from it while
 * another is in flight drops the filter that one was setting.
 *
 * Tested here rather than three times over in the bars, because this is where
 * the fix lives — `KnowledgeFilterBar.test.tsx` asserts one bar end to end, and
 * the contacts and people bars reach the same guarantee through this hook.
 *
 * "In flight" is the default in these tests: `replace` is a spy, so the filters
 * passed in stay where they were until a rerender says otherwise — exactly the
 * window a real navigation opens.
 */

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

interface Filters {
  q?: string;
  status?: string;
}

function toHref(filters: Filters): string {
  const params = new URLSearchParams();

  if (filters.q !== undefined) {
    params.set('q', filters.q);
  }

  if (filters.status !== undefined) {
    params.set('status', filters.status);
  }

  const query = params.toString();

  return query === '' ? '/entries' : `/entries?${query}`;
}

function renderNavigation(filters: Filters = {}) {
  return renderHook(({ committed }) => useFilterNavigation(committed, toHref), {
    initialProps: { committed: filters },
  });
}

beforeEach(() => {
  replace.mockClear();
});

describe('useFilterNavigation', () => {
  it('carries the filters the URL already holds, so a patch sets one and keeps the rest', () => {
    const { result } = renderNavigation({ q: 'returns' });

    act(() => {
      result.current({ status: 'failed' });
    });

    expect(replace).toHaveBeenCalledWith('/entries?q=returns&status=failed', { scroll: false });
  });

  it('carries a filter whose navigation has not landed yet', () => {
    // The reported case: pick a status, then type a term. At the debounce tick
    // the URL still says "all statuses", and navigating from it would send the
    // select back there without the reader touching it.
    const { result } = renderNavigation();

    act(() => {
      result.current({ status: 'failed' });
    });
    act(() => {
      result.current({ q: 'returns' });
    });

    expect(replace).toHaveBeenLastCalledWith('/entries?q=returns&status=failed', { scroll: false });
  });

  it('drops a filter its own patch clears, rather than resurrecting it from the URL', () => {
    // Clearing has to survive the merge, or the search box's clear button would
    // put the term straight back.
    const { result } = renderNavigation({ q: 'returns', status: 'failed' });

    act(() => {
      result.current({ q: undefined });
    });

    expect(replace).toHaveBeenCalledWith('/entries?status=failed', { scroll: false });
  });

  it('forgets the target once the URL has moved, wherever it moved from', () => {
    // The back button, a "clear filters" link, a nav click: any of them commits
    // a URL this hook did not ask for, and the next navigation has to build on
    // that one rather than on a target nobody is waiting for any more.
    const { result, rerender } = renderNavigation({ status: 'failed' });

    act(() => {
      result.current({ q: 'returns' });
    });

    rerender({ committed: {} });

    act(() => {
      result.current({ q: 'delivery' });
    });

    expect(replace).toHaveBeenLastCalledWith('/entries?q=delivery', { scroll: false });
  });
});
