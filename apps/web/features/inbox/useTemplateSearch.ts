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

    void listTemplatesAction(conversationId, {
      limit: TEMPLATE_PAGE_SIZE,
      // Absent rather than empty: the contract's `q` has a floor of one
      // character, and an empty string is "everything", not a search for "".
      ...(trimmed === '' ? {} : { q: trimmed }),
    })
      .then((result) => {
        if (!isCurrent) {
          return;
        }

        setState(
          result.status === 'success'
            ? {
                status: 'ready',
                templates: result.data.items,
                hasMore: result.data.nextCursor !== null,
              }
            : { status: 'failed', message: result.message, requestId: result.requestId },
        );
      })
      .catch((error: unknown) => {
        // Reaches here only if the action itself could not run — a network drop,
        // or a chunk that would not load. Not swallowed.
        console.error('Template search failed', error);

        if (!isCurrent) {
          return;
        }

        setState({ status: 'failed', message: content.errors.body, requestId: null });
      });

    return () => {
      isCurrent = false;
    };
  }, [conversationId, query, attempt]);

  return { state, retry };
}

const LOADING: TemplateSearchState = { status: 'loading' };
