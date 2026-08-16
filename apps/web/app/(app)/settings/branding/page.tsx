import type { Metadata } from 'next';
import { content } from '@/content/en';
import { requirePermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { BrandingSections } from '@/features/branding/components/BrandingSections';

/**
 * Where a tenant admin sets the workspace's logo, favicon, colours and product
 * name (TAR-29). Composition only: header, then the section group behind its own
 * boundary.
 *
 * Gated on `branding:write` — the same permission `PATCH /api/v1/tenant` and both
 * asset routes require — so a principal without it gets a 403 state rather than a
 * form the API would refuse. `settingsNavItems` hides the entry for the same
 * principals. Both are UX: the API enforces it.
 */

export const metadata: Metadata = {
  title: content.branding.title,
  description: content.branding.subtitle,
};

/** Resolves a live session and the tenant's own record; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function BrandingSettingsPage() {
  const session = await requirePermission('branding:write');

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader title={content.branding.title} subtitle={content.branding.subtitle} />
      <SectionErrorBoundary>
        <BrandingSections />
      </SectionErrorBoundary>
    </Stack>
  );
}
