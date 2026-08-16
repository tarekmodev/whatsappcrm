import type { Metadata } from 'next';
import { content } from '@/content/en';
import { requirePermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { DomainSections } from '@/features/domains/components/DomainSections';

/**
 * Where a tenant admin claims and verifies its own hostnames (TAR-29).
 * Composition only: header, then the section group behind its own boundary.
 *
 * Gated on `domain:write` — the same permission every route under
 * `/api/v1/tenant/domains` requires — so a principal without it gets a 403 state
 * rather than controls the API would refuse. `settingsNavItems` hides the entry
 * for the same principals. Both are UX: the API enforces it.
 */

export const metadata: Metadata = {
  title: content.domains.title,
  description: content.domains.subtitle,
};

/** Reads the tenant's own domain rows; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function DomainSettingsPage() {
  const session = await requirePermission('domain:write');

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader title={content.domains.title} subtitle={content.domains.subtitle} />
      <SectionErrorBoundary>
        <DomainSections />
      </SectionErrorBoundary>
    </Stack>
  );
}
