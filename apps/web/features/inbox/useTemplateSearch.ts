'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MessageTemplateResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { listTemplatesAction } from '@/features/inbox/composer.actions';
import { TEMPLATE_PAGE_SIZE } from '@/features/inbox/constants';

/**
 * The approved templates matching what the agent has typed. Usage:
 *
 * ```tsx
 * const { state, retry } = useTemplateSearch(conversationId, debouncedQuery);
 * ```
 *
 * A client-side read, which the rest of this console does not do — every other
 * list is rendered on the server from the URL. This one cannot be: the picker
 * opens inside a dialog, from a click, over a route whose URL has no business
 * carrying a template search. So it reads through a server action, which keeps
 * the permission assertion and the tenant scoping exactly where every other read
 * has them.
 *
 * Two guards, because both cases are reachable by typing quickly and then
 * closing the dialog: a response for a query that is no longer the current one
 * is discarded, and so is one that arrives after unmount.
 */

export type TemplateSearchState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly templates: readonly MessageTemplateResponse[];
      /** More pages exist. The picker asks for a narrower search rather than paging. */
      readonly hasMore: boolean;
    }
  | { readonly status: 'failed'; readonly message: string; readonly requestId: string | null };

export interface TemplateSearch {
  readonly state: TemplateSearchState;
  readonly retry: () => void;
}

export function useTemplateSearch(conversationId: string, query: string): TemplateSearch {
  const [state, setState] = useState<TemplateSearchState>(LOADING);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    let isCurrent = true;
    const trimmed = query.trim();

    setState(LOADING);

    void readUntilAnyItems(conversationId, trimmed, () => isCurrent)
      .then((next) => {
        if (isCurrent) {
          setState(next);
        }
      })
      .catch((error: unknown) => {
        // Reaches here only if the action itself could not run — a network drop,
        // or a chunk that would not load. Not swallowed.
        console.error('Template search failed', error);

        if (isCurrent) {
          setState({ status: 'failed', message: content.errors.body, requestId: null });
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [conversationId, query, attempt]);

  return { state, retry };
}

/**
 * Reads pages until one yields a template, or the feed ends.
 *
 * **A short page is not the end of the feed, and an empty one is not an empty
 * feed.** The endpoint drops templates whose buttons take a parameter *after*
 * reading each page, so a page can come back with fewer items than `limit` — or
 * none at all — while `nextCursor` still points at more. Stopping on the first
 * page is how a tenant whose alphabetically-first hundred templates all carry
 * buttons gets told they have none, with sendable ones sitting on page two.
 *
 * It stops at the first page that yields anything rather than reading the whole
 * feed: the picker only has to fill one screen, and the agent narrows it with
 * `q` from there.
 */
async function readUntilAnyItems(
  conversationId: string,
  query: string,
  isCurrent: () => boolean,
): Promise<TemplateSearchState> {
  const templates: MessageTemplateResponse[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await listTemplatesAction(conversationId, {
      limit: TEMPLATE_PAGE_SIZE,
      // Absent rather than empty: the contract's `q` has a floor of one
      // character, and an empty string is "everything", not a search for "".
      ...(query === '' ? {} : { q: query }),
      ...(cursor === null ? {} : { cursor }),
    });

    if (result.status === 'error') {
      return { status: 'failed', message: result.message, requestId: result.requestId };
    }

    // The dialog closed, or the query moved on. Stop paging for a screen that
    // will never read the answer.
    if (!isCurrent()) {
      return LOADING;
    }

    templates.push(...result.data.items);
    cursor = result.data.nextCursor;

    if (templates.length > 0 || cursor === null) {
      return { status: 'ready', templates, hasMore: cursor !== null };
    }
  }

  // Every page so far was emptied by the button-parameter exclusion. Reported as
  // "there is more, narrow it" rather than as an empty feed, because that is
  // what it is — and it is the honest answer for a picker that has stopped
  // reading rather than reached the end.
  return { status: 'ready', templates, hasMore: true };
}

/**
 * How many empty pages to read through before handing back. A backstop against
 * a tenant with thousands of button templates turning an open into a stall, not
 * a page budget an ordinary search ever reaches — the first page almost always
 * yields something.
 */
const MAX_PAGES = 5;

const LOADING: TemplateSearchState = { status: 'loading' };
