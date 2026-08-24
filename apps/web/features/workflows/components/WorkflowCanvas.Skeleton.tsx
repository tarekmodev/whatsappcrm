'use client';

import type { CSSProperties } from 'react';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { NODE_HEIGHT, NODE_WIDTH } from '../graph';
import { CANVAS_SKELETON_NODE_COUNT } from '../constants';
import styles from './WorkflowCanvas.Skeleton.module.css';

/**
 * What stands where the canvas will be, while its chunk loads. Usage: as the
 * `loading` fallback of `LazyWorkflowCanvas`, and inside the route's own
 * `loading.tsx`.
 *
 * It draws the same viewport box as `WorkflowCanvas.module.css` — the same
 * `60dvh` floor, border and ground — from the same tokens, so the swap moves
 * nothing on the page. The node boxes take their size from `graph.ts`'s
 * `NODE_WIDTH` / `NODE_HEIGHT`, the same two numbers the real cards are sized
 * from, which is what keeps this from drifting when the geometry changes.
 *
 * `aria-hidden` throughout with one polite announcement, so a screen reader
 * hears "Loading the workflow" rather than a wall of placeholders.
 */
export function WorkflowCanvasSkeleton() {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.workflows.canvasLoading} />
      <div
        className={styles.viewport}
        aria-hidden="true"
        style={
          {
            '--node-width': `${String(NODE_WIDTH)}px`,
            '--node-height': `${String(NODE_HEIGHT)}px`,
          } as CSSProperties
        }
      >
        {Array.from({ length: CANVAS_SKELETON_NODE_COUNT }, (_unused, index) => (
          <div key={index} className={styles.node}>
            <SkeletonLine width="5rem" height="var(--font-size-caption)" />
            <SkeletonLine width="80%" />
          </div>
        ))}
      </div>
    </>
  );
}
