'use client';

import dynamic from 'next/dynamic';
import { WorkflowCanvasSkeleton } from './WorkflowCanvas.Skeleton';

/**
 * The canvas chunk, and the boundary that keeps it off every other route.
 *
 * `@xyflow/react` is ~59 KB gzipped — the whole of this route's third-party
 * cost, and about a tenth of the app's total client JS (TAR-809, Decision 1).
 * The library is imported *only* by `WorkflowCanvas`, and `WorkflowCanvas` is
 * imported *only* here, so the chunk splits at this boundary and no other
 * console surface pays for it.
 *
 * `ssr: false` is a requirement rather than a preference: React Flow measures
 * the DOM to size its viewport and renders nothing useful on the server. The
 * fallback is the canvas's own skeleton, drawing the same `60dvh` box, so the
 * swap shifts nothing.
 */
export const LazyWorkflowCanvas = dynamic(
  async () => (await import('./WorkflowCanvas')).WorkflowCanvas,
  { ssr: false, loading: () => <WorkflowCanvasSkeleton /> },
);
