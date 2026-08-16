'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * Dialog chunks, loaded on first open rather than with the page.
 *
 * None of these is above the fold or on the LCP path, and between them they pull
 * in the form hook, the option editor and the whole validation module — so they
 * belong behind a boundary. Their `loading` fallback is the shared dialog
 * skeleton, sized like the panel it stands in for, so opening one never flashes
 * an empty sheet.
 *
 * `ssr: false` because a dialog only ever mounts in response to a click — there
 * is no server render of it to be had, and no indexable content inside it.
 */

export const LazyCreateCustomFieldDialog = dynamic(
  async () => (await import('./CreateCustomFieldDialog')).CreateCustomFieldDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyEditCustomFieldDialog = dynamic(
  async () => (await import('./EditCustomFieldDialog')).EditCustomFieldDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyDeleteCustomFieldDialog = dynamic(
  async () => (await import('./DeleteCustomFieldDialog')).DeleteCustomFieldDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);
