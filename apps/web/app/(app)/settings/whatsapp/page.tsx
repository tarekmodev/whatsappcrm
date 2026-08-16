import type { Metadata } from 'next';
import { content } from '@/content/en';
import { requirePermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { WhatsAppSections } from '@/features/whatsapp/components/WhatsAppSections';

/**
 * Where a tenant admin connects its own WhatsApp Business Account through Meta's
 * Embedded Signup (TAR-169). Composition only: header, then the section group
 * behind its own boundary.
 *
 * Gated on `channel:manage` — the same permission `POST
 * /api/v1/whatsapp/business-accounts` requires — so a principal without it gets a
 * 403 state rather than a button the API would refuse. `settingsNavItems` hides
 * the entry for the same principals. Both are UX: the API enforces it.
 */

export const metadata: Metadata = {
  title: content.whatsapp.title,
  description: content.whatsapp.subtitle,
};

/** Resolves a live session to decide what to render; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function WhatsAppSettingsPage() {
  const session = await requirePermission('channel:manage');

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader title={content.whatsapp.title} subtitle={content.whatsapp.subtitle} />
      <SectionErrorBoundary>
        <WhatsAppSections />
      </SectionErrorBoundary>
    </Stack>
  );
}
