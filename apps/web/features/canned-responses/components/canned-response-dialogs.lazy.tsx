'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * Dialog chunks, loaded on first open rather than with the page.
 *
 * None of these is above the fold or on the LCP path, and between them they pull
 * in the form hook and the whole validation module — so they belong behind a
 * boundary. Their `loading` fallback is the shared dialog skeleton, sized like
 * the panel it stands in for, so opening one never flashes an empty sheet.
 *
 * `ssr: false` because a dialog only ever mounts in response to a click — there
 * is no server render of it to be had, and no indexable content inside it.
 */

export const LazyCreateCannedResponseDialog = dynamic(
  async () => (await import('./CreateCannedResponseDialog')).CreateCannedResponseDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyEditCannedResponseDialog = dynamic(
  async () => (await import('./EditCannedResponseDialog')).EditCannedResponseDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyDeleteCannedResponseDialog = dynamic(
  async () => (await import('./DeleteCannedResponseDialog')).DeleteCannedResponseDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);
