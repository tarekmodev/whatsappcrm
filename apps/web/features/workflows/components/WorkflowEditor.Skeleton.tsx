'use client';

import { SkeletonBlock, SkeletonLine } from '@/components/ui/Skeleton';
import { WorkflowCanvasSkeleton } from './WorkflowCanvas.Skeleton';
import editorStyles from './WorkflowEditor.module.css';
import inspectorStyles from './WorkflowNodeInspector.module.css';

/**
 * What stands where the editor will be. Usage: the route's `loading.tsx`, and
 * the Suspense fallback around `WorkflowEditorPanel`.
 *
 * It reuses the editor's **own** module classes rather than approximating them,
 * so the two cannot drift: the same header row, the same two-column grid from
 * 64rem, the same inspector frame. The canvas half is the canvas's own skeleton,
 * which is what keeps one description of that box in one file.
 *
 * `aria-hidden` throughout — the announcement is made once by
 * `WorkflowCanvasSkeleton`, not four times by four regions.
 */
export function WorkflowEditorSkeleton() {
  return (
    <div className={editorStyles.editor}>
      <div className={editorStyles.header} aria-hidden="true">
        <div className={editorStyles.name}>
          <SkeletonLine width="8rem" height="var(--font-size-caption)" />
          <SkeletonBlock height="var(--size-control-md)" />
        </div>
        <div className={editorStyles.actions}>
          <SkeletonBlock height="var(--size-control-md)" />
        </div>
      </div>

      <div className={editorStyles.surface}>
        <div className={editorStyles.canvas}>
          <WorkflowCanvasSkeleton />
        </div>

        <section className={inspectorStyles.panel} aria-hidden="true">
          <SkeletonLine width="7rem" height="var(--font-size-body)" />
          <SkeletonBlock height="var(--size-control-md)" />
          <SkeletonBlock height="var(--size-control-md)" />
        </section>
      </div>
    </div>
  );
}
