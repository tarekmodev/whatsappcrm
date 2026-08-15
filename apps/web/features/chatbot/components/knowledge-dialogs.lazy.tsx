'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * The knowledge base dialog chunks, loaded on first open rather than with the
 * page.
 *
 * `KnowledgeEntryDialog` is the heaviest widget on this surface — three fields,
 * a ten-row editor and the whole validation module — and none of it is needed to
 * *read* the knowledge base. Keeping it behind a boundary is what stops an admin
 * who only wanted to check what the chatbot knows from downloading the editor.
 *
 * `ssr: false` because a dialog only ever mounts in response to a click: there
 * is no server render of it to be had, and no indexable content inside it. The
 * `loading` fallback is the shared dialog skeleton, sized like the panel it
 * stands in for, so opening one never flashes an empty sheet.
 */

export const LazyKnowledgeEntryDialog = dynamic(
  async () => (await import('./KnowledgeEntryDialog')).KnowledgeEntryDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyDeleteKnowledgeEntryDialog = dynamic(
  async () => (await import('./DeleteKnowledgeEntryDialog')).DeleteKnowledgeEntryDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);
