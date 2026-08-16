import type { Metadata } from 'next';
import { content } from '@/content/en';
import { verifySession } from '@/lib/session/session';
import { PageHeader } from '@/components/shell/PageHeader';
import { Stack } from '@/components/layout/Stack';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { SecuritySections } from '@/features/auth/components/SecuritySections';

/**
 * The caller's own account security. Composition only: header, then the section
 * group behind its own boundary.
 *
 * Gated by no permission, and that is the decision rather than an omission — the
 * subject of this page is the caller, and a role that cannot change its own
 * password is a role that cannot recover from a leaked one. `settingsNavItems`
 * makes the same call for the navigation entry.
 */

export const metadata: Metadata = {
  title: content.auth.securityTitle,
  description: content.auth.securitySubtitle,
};

/** Renders the signed-in principal's own address; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  const { principal } = await verifySession();

  return (
    <Stack gap="5">
      <PageHeader title={content.auth.securityTitle} subtitle={content.auth.securitySubtitle} />
      <SectionErrorBoundary>
        <SecuritySections email={principal.email} />
      </SectionErrorBoundary>
    </Stack>
  );
}
