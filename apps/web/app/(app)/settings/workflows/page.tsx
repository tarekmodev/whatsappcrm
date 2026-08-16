import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { requirePermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  WorkflowsPanel,
  WorkflowsPanelSkeleton,
} from '@/features/workflows/components/WorkflowsPanel';

/**
 * The automation builder (TAR-27). Composition only.
 *
 * Gated on `workflow:read`, which is the permission ADR 0009 assigns the
 * endpoints behind it. Writing is a second, narrower check handed to the panel,
 * so a principal who may read the workflows but not change them is shown them
 * rather than a page of controls the API would refuse.
 *
 * One section rather than three, because there is one read here: a workflow's
 * runs and its dry run are both per workflow and both open from the list.
 */

export const metadata: Metadata = {
  title: `${content.workflows.title} · ${content.app.name}`,
  description: content.workflows.subtitle,
};

/** Per-principal, from a live session; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function WorkflowsPage() {
  const session = await requirePermission('workflow:read');

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader title={content.workflows.title} subtitle={content.workflows.subtitle} />

      <SectionErrorBoundary>
        <Suspense fallback={<WorkflowsPanelSkeleton />}>
          <WorkflowsPanel canWrite={session.checker.can('workflow:write')} />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
