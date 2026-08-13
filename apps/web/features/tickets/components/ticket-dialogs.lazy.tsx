'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * The resolve/close confirmation, loaded on first open rather than with the
 * page.
 *
 * It is neither above the fold nor on the LCP path, and it pulls in the modal
 * and the form-dialog frame behind it, so it belongs behind a boundary. The
 * fallback is the shared dialog skeleton, sized like the panel it stands in for,
 * so opening it never flashes an empty sheet.
 *
 * `ssr: false` because a confirmation only ever mounts in response to a click —
 * there is no server render of it to be had, and no indexable content inside it.
 */
export const LazyConfirmTicketStatusDialog = dynamic(
  async () => (await import('./ConfirmTicketStatusDialog')).ConfirmTicketStatusDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);
