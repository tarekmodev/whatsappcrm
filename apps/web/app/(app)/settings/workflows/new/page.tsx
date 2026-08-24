import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { requirePermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  WorkflowEditorPanel,
  WorkflowEditorPanelSkeleton,
} from '@/features/workflows/components/WorkflowEditorPanel';

/**
 * The canvas over a blank draft (TAR-812). Composition only.
 *
 * Gated on `workflow:read` like the list, and the gate is repeated here rather
 * than assumed from it: a route is reachable by a typed URL, so it does its own
 * check. Writing is the narrower second check handed to the panel — a principal
 * who may read workflows but not change them gets the canvas read-only rather
 * than a page of controls the API would refuse.
 */

export const metadata: Metadata = {
  title: `${content.workflows.canvasNewTitle} · ${content.app.name}`,
  description: content.workflows.canvasNewSubtitle,
};

/** Per-principal, from a live session; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function NewWorkflowPage() {
  const session = await requirePermission('workflow:read');

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader
        title={content.workflows.canvasNewTitle}
        subtitle={content.workflows.canvasNewSubtitle}
      />

      <SectionErrorBoundary>
        <Suspense fallback={<WorkflowEditorPanelSkeleton />}>
          <WorkflowEditorPanel canWrite={session.checker.can('workflow:write')} />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
