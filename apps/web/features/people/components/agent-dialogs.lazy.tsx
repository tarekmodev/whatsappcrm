'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * Dialog chunks, loaded on first open rather than with the page.
 *
 * None of these is above the fold or on the LCP path, and each pulls in form state
 * and validation, so they belong behind a boundary. Their `loading` fallback is the
 * shared dialog skeleton, sized like the panel it stands in for, so opening one
 * never flashes an empty sheet.
 *
 * `ssr: false` because a dialog only ever mounts in response to a click — there is
 * no server render of it to be had, and no indexable content inside it.
 */

export const LazyInviteAgentDialog = dynamic(
  async () => (await import('./InviteAgentDialog')).InviteAgentDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyEditAgentDialog = dynamic(
  async () => (await import('./EditAgentDialog')).EditAgentDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyRemoveAgentDialog = dynamic(
  async () => (await import('./RemoveAgentDialog')).RemoveAgentDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);
