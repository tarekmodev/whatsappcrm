import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { requireAnyPermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  AssignmentSections,
  AssignmentSectionsSkeleton,
} from '@/features/assignment/components/AssignmentSections';

/**
 * The supervisor's reporting and assignment view. Composition only.
 *
 * Gated on `report:read_all` / `assignment_rule:read`, which the contract's
 * role table grants to supervisor and admin but not to agent — so this is exactly
 * TAR-22's third acceptance criterion, and an agent reaching the URL gets a 403
 * state rather than a tenant-wide report.
 */

export const metadata: Metadata = {
  title: `${content.assignment.title} · ${content.app.name}`,
  description: content.assignment.subtitle,
};

/** Per-principal figures from a live session; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

const ASSIGNMENT_PERMISSIONS = ['report:read_all', 'assignment_rule:read'] as const;

export default async function AssignmentPage() {
  const session = await requireAnyPermission(ASSIGNMENT_PERMISSIONS);

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader title={content.assignment.title} subtitle={content.assignment.subtitle} />
      <SectionErrorBoundary>
        <Suspense fallback={<AssignmentSectionsSkeleton />}>
          <AssignmentSections />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
