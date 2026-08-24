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
 * The canvas over one existing workflow (TAR-812). Composition only.
 *
 * Which workflow is being edited lives in the URL rather than in dialog state,
 * which is the change this route *is*: a refresh, a copied link and the back
 * button all reproduce the same editor.
 */

/**
 * The workflow's own name would be the better title, and it is deliberately not
 * used: resolving it here would mean a second read of the tenant's workflow set
 * before the page streams, purely to fill a `<title>`. The heading inside the
 * canvas is the name field itself, which is the thing being edited.
 */
export const metadata: Metadata = {
  title: `${content.workflows.title} · ${content.app.name}`,
  description: content.workflows.canvasEditSubtitle,
};

/** Per-principal, from a live session; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function EditWorkflowPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const [session, { workflowId }] = await Promise.all([requirePermission('workflow:read'), params]);

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader title={content.workflows.title} subtitle={content.workflows.canvasEditSubtitle} />

      <SectionErrorBoundary>
        <Suspense fallback={<WorkflowEditorPanelSkeleton />}>
          <WorkflowEditorPanel
            workflowId={workflowId}
            canWrite={session.checker.can('workflow:write')}
          />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
