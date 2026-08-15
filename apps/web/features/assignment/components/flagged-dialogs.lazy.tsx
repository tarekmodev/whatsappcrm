'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * The assign dialog's chunk, loaded on first open rather than with the page.
 *
 * `ssr: false` because a dialog only ever mounts in response to a click — there is
 * no server render of it to be had, and no indexable content inside it.
 */
export const LazyAssignFlaggedTicketDialog = dynamic(
  async () => (await import('./AssignFlaggedTicketDialog')).AssignFlaggedTicketDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);
