'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * Team dialog chunks, loaded on first open. Same reasoning as
 * `agent-dialogs.lazy.tsx`: neither is on the LCP path, and each carries form state.
 */

export const LazyCreateTeamDialog = dynamic(
  async () => (await import('./CreateTeamDialog')).CreateTeamDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyTeamMembersDialog = dynamic(
  async () => (await import('./TeamMembersDialog')).TeamMembersDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);
