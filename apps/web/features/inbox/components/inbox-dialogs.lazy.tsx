'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * Dialog chunks for the inbox, loaded on first open rather than with the page.
 *
 * The inbox is the app's busiest route and a take-over confirmation is opened by
 * a minority of readers on a minority of threads, so it has no business in the
 * route's initial JavaScript. `ssr: false` because a dialog only ever mounts in
 * response to a click — there is no server render of it to be had.
 */
export const LazyTakeOverDialog = dynamic(
  async () => (await import('./TakeOverDialog')).TakeOverDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);
