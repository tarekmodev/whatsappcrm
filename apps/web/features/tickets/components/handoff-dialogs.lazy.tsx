'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * The two handoff dialogs, loaded on first open rather than with the page.
 *
 * Neither is above the fold or on the LCP path, and each pulls in the modal, the
 * form-dialog frame and a form's worth of state behind it — so both belong
 * behind a boundary, the same one `ticket-dialogs.lazy.tsx` puts the terminal
 * confirmation behind. The fallback is the shared dialog skeleton, sized like
 * the sheet it stands in for, so opening one never flashes an empty panel.
 *
 * Two entries rather than one chunk holding both: an agent who reassigns has no
 * reason to download the escalation form, and they are opened by different
 * buttons.
 *
 * `ssr: false` because a dialog only ever mounts in response to a click — there
 * is no server render of it to be had, and nothing inside it is indexable.
 */

export const LazyReassignTicketDialog = dynamic(
  async () => (await import('./ReassignTicketDialog')).ReassignTicketDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyEscalateTicketDialog = dynamic(
  async () => (await import('./EscalateTicketDialog')).EscalateTicketDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);
