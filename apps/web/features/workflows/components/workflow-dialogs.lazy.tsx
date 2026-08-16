'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * The workflow dialog chunks, loaded on first open rather than with the page.
 *
 * `WorkflowFormDialog` is by far the heaviest widget on this surface — seven
 * condition editors, five action editors, the trigger field and the whole
 * validation module — and none of it is needed to *read* the list. Keeping it
 * behind a boundary is what stops a supervisor who only wanted to check the
 * order from downloading the builder.
 *
 * `ssr: false` because a dialog only ever mounts in response to a click: there
 * is no server render of it to be had, and no indexable content inside it. The
 * `loading` fallback is the shared dialog skeleton, sized like the panel it
 * stands in for, so opening one never flashes an empty sheet.
 */

export const LazyWorkflowFormDialog = dynamic(
  async () => (await import('./WorkflowFormDialog')).WorkflowFormDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

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
