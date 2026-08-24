'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * The workflow dialog chunks, loaded on first open rather than with the page.
 *
 * None of the three is needed to *read* the list, and the run history is the
 * heaviest of them. Keeping each behind its own boundary is what stops a
 * supervisor who only wanted to check the order from downloading all three.
 *
 * The builder used to be the heavy one here. It is a route now — see
 * `workflow-canvas.lazy.tsx`, which is where `@xyflow/react` is confined.
 *
 * `ssr: false` because a dialog only ever mounts in response to a click: there
 * is no server render of it to be had, and no indexable content inside it. The
 * `loading` fallback is the shared dialog skeleton, sized like the panel it
 * stands in for, so opening one never flashes an empty sheet.
 */

export const LazyDeleteWorkflowDialog = dynamic(
  async () => (await import('./DeleteWorkflowDialog')).DeleteWorkflowDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyTestWorkflowDialog = dynamic(
  async () => (await import('./TestWorkflowDialog')).TestWorkflowDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyWorkflowRunsDialog = dynamic(
  async () => (await import('./WorkflowRunsDialog')).WorkflowRunsDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);
