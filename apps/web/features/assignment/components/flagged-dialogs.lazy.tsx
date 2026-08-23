'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * The queue's dialog chunks, each loaded on first open rather than with the page.
 *
 * `ssr: false` because a dialog only ever mounts in response to a click — there is
 * no server render of it to be had, and no indexable content inside it.
 */
export const LazyAssignFlaggedTicketDialog = dynamic(
  async () => (await import('./AssignFlaggedTicketDialog')).AssignFlaggedTicketDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

/**
 * The cap-edit control (TAR-384). Its own boundary rather than a branch inside
 * the one above: a supervisor who only ever assigns tickets should not pay for
 * the limits form, and vice versa.
 */
export const LazyAgentCapacityDialog = dynamic(
  async () => (await import('./AgentCapacityDialog')).AgentCapacityDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);
