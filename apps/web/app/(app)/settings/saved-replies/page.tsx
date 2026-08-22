import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { requirePermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  CannedResponsesSection,
  CannedResponsesSectionSkeleton,
} from '@/features/canned-responses/components/CannedResponsesSection';

/**
 * Where a supervisor or an admin keeps the workspace's saved replies — the
 * write half of TAR-31, missing until TAR-575: the CRUD API and the composer's
 * read side both shipped, and nothing in the console called the writes.
 *
 * Composition only: gate, header, and the section behind its own error and
 * Suspense boundaries.
 *
 * Gated on `canned_response:write`, the permission the three mutating endpoints
 * require. Reading the library needs only `canned_response:read`, which every
 * agent holds so the composer can expand a shortcut — but a screen whose every
 * control the API would refuse is not a screen worth showing, so the whole page
 * takes the write permission. `settingsNavItems` hides the entry on the same
 * rule.
 */

export const metadata: Metadata = {
  title: `${content.cannedResponses.title} · ${content.app.name}`,
  description: content.cannedResponses.subtitle,
};

/** Resolves a live session and the tenant's live library; nothing is cacheable. */
export const dynamic = 'force-dynamic';

export default async function SavedRepliesSettingsPage() {
  const session = await requirePermission('canned_response:write');

  if (session === null) {
    return <ForbiddenState />;
  }

  return (
    <Stack gap="5">
      <PageHeader
        title={content.cannedResponses.title}
        subtitle={content.cannedResponses.subtitle}
      />
      <SectionErrorBoundary>
        <Suspense fallback={<CannedResponsesSectionSkeleton />}>
          <CannedResponsesSection canManage />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
