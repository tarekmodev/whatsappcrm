'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { INDEXING_REFRESH_INTERVAL_MS } from './constants';

/**
 * Refetches the chatbot page while any knowledge base entry is still being
 * indexed. Usage: `useIndexingRefresh(documents.some((d) => d.status === 'pending'))`
 * from the table that renders those rows.
 *
 * `Indexing` is a **transient** status — the worker splits the entry and the row
 * becomes `Ready` or `Failed` within seconds — and a page that only learns this
 * when somebody reloads leaves an admin watching a status that is already wrong,
 * with no way to tell a slow index from a stuck one.
 *
 * `router.refresh()` rather than a poll of the API: the route is
 * `force-dynamic`, so the refetch re-runs the same server read and the same
 * permission checks that produced the page, and readiness above the table moves
 * with the rows below it rather than disagreeing with them.
 *
 * Two things keep it from being a busy loop. It runs **only while something is
 * pending**, so a settled knowledge base makes no requests at all; and it skips
 * a tick while the tab is hidden, because a background tab refetching every few
 * seconds is a cost with no reader. The next visible tick catches up — the
 * refetch is the whole state, not a delta, so nothing is missed by skipping one.
 */
export function useIndexingRefresh(isIndexing: boolean): void {
  const router = useRouter();

  useEffect(() => {
    if (!isIndexing) {
      return;
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      router.refresh();
    }, INDEXING_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [isIndexing, router]);
}
