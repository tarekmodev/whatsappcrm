import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { requirePermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  CustomFieldsSection,
  CustomFieldsSectionSkeleton,
} from '@/features/custom-fields/components/CustomFieldsSection';

/**
 * Where an admin defines the tenant's contact schema — 0002 amendment 10's
 * `custom_field_defs` surface. Composition only: gate, header, and the section
 * behind its own error and Suspense boundaries.
 *
 * Gated on `tenant:settings`, the permission the mutating endpoints require.
 * Reading the definitions needs only `contact:read`, which every agent holds —
 * but a screen whose every control the API would refuse is not a screen worth
 * showing, so the whole page takes the write permission. `settingsNavItems`
 * hides the entry on the same rule.
 */

export const metadata: Metadata = {
  title: `${content.customFields.title} · ${content.app.name}`,
  description: content.customFields.subtitle,
};

/** Resolves a live session and the tenant's live schema; nothing is cacheable. */
export const dynamic = 'force-dynamic';

export default async function CustomFieldsSettingsPage() {
  const session = await requirePermission('tenant:settings');

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader title={content.customFields.title} subtitle={content.customFields.subtitle} />
      <SectionErrorBoundary>
        <Suspense fallback={<CustomFieldsSectionSkeleton />}>
          <CustomFieldsSection canManage />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
