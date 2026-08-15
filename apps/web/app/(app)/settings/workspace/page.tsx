import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { requireAnyPermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  WorkspaceSections,
  WorkspaceSectionsSkeleton,
  WORKSPACE_PERMISSIONS,
} from '@/features/workspace/components/WorkspaceSections';

/**
 * The workspace settings surface (TAR-409): profile, plan state and seat usage.
 * Composition only — gate, header, and the section group behind its own error
 * and Suspense boundaries.
 *
 * Gated on *either* permission rather than both, because the page is two
 * surfaces: `branding:write` for the profile and `tenant:settings` for the plan
 * panel. `settingsNavItems` hides the entry on the same rule. Both are UX; the
 * API enforces each endpoint independently.
 */

export const metadata: Metadata = {
  title: `${content.workspace.title} · ${content.app.name}`,
  description: content.workspace.subtitle,
};

/** Resolves a live session and live usage counts; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

const WORKSPACE_SETTINGS_PERMISSIONS = [
  WORKSPACE_PERMISSIONS.readPlan,
  WORKSPACE_PERMISSIONS.editProfile,
] as const;

export default async function WorkspaceSettingsPage() {
  const session = await requireAnyPermission(WORKSPACE_SETTINGS_PERMISSIONS);

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader title={content.workspace.title} subtitle={content.workspace.subtitle} />
      <SectionErrorBoundary>
        <Suspense fallback={<WorkspaceSectionsSkeleton />}>
          <WorkspaceSections checker={session.checker} />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
