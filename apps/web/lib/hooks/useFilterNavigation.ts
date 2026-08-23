'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Navigates a filter bar's URL filters from the filters the *next* URL will
 * hold, rather than from the ones the current one does. Usage:
 *
 * ```tsx
 * const filters = useMemo(() => ({ q, status }), [q, status]);
 * const replaceFilters = useFilterNavigation<ChatbotQuery>(filters, routes.settingsChatbot);
 * replaceFilters({ status: 'failed' }); // keeps `q`, whether or not the URL has it yet
 * ```
 *
 * `useSearchParams` reflects the **committed** URL, so while a `router.replace`
 * is in flight it is stale — and a bar that computes its next URL from it drops
 * the filter the in-flight one was setting. Pick a status, then type a term: if
 * the status navigation outlasts the 300 ms debounce, the replace that lands
 * carries `q` with no `status` and the select springs back to "All statuses".
 * The mirror case drops `q`. Both self-heal on the next interaction, so the cost
 * is a lost click rather than a wrong view — which is exactly why nobody
 * reported it.
 *
 * So the target of the last navigation is kept in a ref and the next patch is
 * merged into *that*, until the URL catches up. Any change to the committed URL
 * drops the target — the navigation landing, the back button, a "clear filters"
 * link — so a stale one can never outlive the URL it was computed against.
 *
 * A ref rather than `useTransition`'s `isPending`: gating the debounce on a
 * pending navigation would hold a typed term back until the previous one lands,
 * where merging lets it navigate straight to the state the reader asked for.
 *
 * The bar keeps its own draft of the search box, because the URL is not where
 * an unfired keystroke lives. Pass it in the patch (`q: searchTermParam(draft)`)
 * rather than leaving it to be merged, so a status chosen mid-word does not
 * discard the keystrokes the debounce has not fired yet.
 */
export function useFilterNavigation<T extends object>(
  /** The filters the committed URL holds. Memoise it, or the callback churns. */
  filters: T,
  /** The route builder that turns filters into an href, e.g. `routes.contacts`. */
  toHref: (filters: T) => string,
): (patch: Partial<T>) => void {
  const router = useRouter();

  /** Where the last `replace` was headed, or `null` when the URL has caught up. */
  const pendingRef = useRef<T | null>(null);
  const committedHref = toHref(filters);

  useEffect(() => {
    pendingRef.current = null;
  }, [committedHref]);

  return useCallback(
    (patch: Partial<T>) => {
      const next: T = { ...(pendingRef.current ?? filters), ...patch };

      pendingRef.current = next;
      // `replace`, so a search does not fill the back stack with every prefix.
      router.replace(toHref(next), { scroll: false });
    },
    [filters, toHref, router],
  );
}
