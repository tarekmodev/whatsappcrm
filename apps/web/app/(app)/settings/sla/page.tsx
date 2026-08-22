import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { requireAnyPermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  SlaSettingsSections,
  SlaSettingsSectionsSkeleton,
  SLA_SETTINGS_PERMISSIONS,
} from '@/features/sla/components/SlaSettingsSections';

/**
 * The response-deadline settings surface (TAR-390): the SLA window every new
 * ticket is measured against. Composition only — gate, header, and the section
 * group behind its own error and Suspense boundaries.
 *
 * Gated on either permission rather than on `sla:write`, so a principal who may
 * read the window gets a read-only surface instead of a 403.
 * `settingsNavItems` hides the entry on the same rule. Both are UX; the API
 * enforces `sla:read` and `sla:write` independently, which is TAR-22's role
 * model doing the actual work.
 */

export const metadata: Metadata = {
  title: `${content.slaSettings.title} · ${content.app.name}`,
  description: content.slaSettings.subtitle,
};

/** Resolves a live session and the tenant's current policy; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

const SLA_PAGE_PERMISSIONS = [
  SLA_SETTINGS_PERMISSIONS.read,
  SLA_SETTINGS_PERMISSIONS.write,
] as const;

export default async function SlaSettingsPage() {
  const session = await requireAnyPermission(SLA_PAGE_PERMISSIONS);

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader title={content.slaSettings.title} subtitle={content.slaSettings.subtitle} />
      <SectionErrorBoundary>
        <Suspense fallback={<SlaSettingsSectionsSkeleton />}>
          <SlaSettingsSections checker={session.checker} />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
