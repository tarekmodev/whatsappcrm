'use client';

import { useCallback, useEffect, useState } from 'react';
import type { KnowledgeDocumentResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { loadKnowledgeEntryAction } from './chatbot.actions';

/**
 * Reads one knowledge base entry with its text, for the editor opening on it.
 * Usage: `const entry = useKnowledgeEntry(documentId)`.
 *
 * The list endpoint omits `content` — a page of entries each holding up to
 * 256 KiB is a response nobody wants — so the row the table holds cannot fill an
 * editor. This is the one extra read that buys the editor something real to show
 * instead of an empty textarea that would save its emptiness back.
 *
 * A discriminated union rather than three booleans: "loaded but errored" and
 * "still loading with stale data" are states this cannot represent, which is the
 * point.
 */

export type KnowledgeEntryState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entry: KnowledgeDocumentResponse }
  | { readonly status: 'error'; readonly message: string };

export function useKnowledgeEntry(documentId: string): KnowledgeEntryState & {
  readonly retry: () => void;
} {
  const [state, setState] = useState<KnowledgeEntryState>({ status: 'loading' });
  // Bumped by `retry`, and part of the effect's dependencies, so a retry is one
  // re-run of the same read rather than a second code path that can drift.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Guards the late resolve: the dialog can close, or the row change, while
    // the read is in flight, and setting state then would either warn or show
    // the previous entry's text in the current entry's form.
    let isCurrent = true;

    setState({ status: 'loading' });

    void loadKnowledgeEntryAction(documentId)
      .then((result) => {
        if (!isCurrent) {
          return;
        }

        setState(
          result.status === 'success'
            ? { status: 'ready', entry: result.data }
            : { status: 'error', message: result.message },
        );
      })
      .catch((error: unknown) => {
        // Reaches here only if the action itself could not run — a network drop,
        // or a chunk that would not load. Never swallowed.
        console.error('Knowledge entry read failed', error);

        if (isCurrent) {
          setState({ status: 'error', message: content.chatbot.editLoadFailed });
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [documentId, attempt]);

  const retry = useCallback(() => {
    setAttempt((previous) => previous + 1);
  }, []);

  return { ...state, retry };
}
