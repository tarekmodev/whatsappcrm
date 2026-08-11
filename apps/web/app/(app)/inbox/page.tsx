import { Suspense } from 'react';
import type { Metadata } from 'next';
import { ConversationListQuerySchema } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { searchParamKeys, type ConversationStatusFilter, type InboxScope } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { verifySession } from '@/lib/session/session';
import { allowedConversationScopes } from '@/lib/session/permissions';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { InboxScopeTabs } from '@/features/inbox/components/InboxScopeTabs';
import { InboxSection, InboxSectionSkeleton } from '@/features/inbox/components/InboxSection';

/**
 * The agent's home. Composition only.
 *
 * This is TAR-22's first acceptance criterion: an agent's scope is capped at
 * `assigned` — their own and their teams' conversations — and the tenant-admin
 * settings surface is not in the navigation they are served at all.
 */

export const metadata: Metadata = {
  title: `${content.inbox.title} · ${content.app.name}`,
  description: content.app.description,
};

/** Per-principal scoping from a live session; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const { checker } = await verifySession();
  const params = await searchParams;

  const availableScopes = allowedConversationScopes(checker);
  const requestedScope = parseScope(firstSearchParam(params[searchParamKeys.inboxScope]));
  // Narrowed here as well as by the API, so the tab strip and the list agree about
  // which scope is actually in effect.
  const effectiveScope = availableScopes.includes(requestedScope) ? requestedScope : 'assigned';
  const status = parseStatus(firstSearchParam(params[searchParamKeys.inboxStatus]));

  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.inbox.title} />
        <InboxScopeTabs
          availableScopes={availableScopes}
          activeScope={effectiveScope}
          activeStatus={status}
        />
        <SectionErrorBoundary>
          {/* Keyed on the filters so changing one shows the skeleton again rather
              than leaving the previous scope's rows on screen. */}
          <Suspense key={`${effectiveScope}:${status ?? ''}`} fallback={<InboxSectionSkeleton />}>
            <InboxSection query={{ requestedScope, effectiveScope, status }} />
          </Suspense>
        </SectionErrorBoundary>
      </Stack>
    </PageShell>
  );
}

/** The URL is untrusted; the contract's own schema decides what is valid. */
function parseScope(value: string | undefined): InboxScope {
  const parsed = ConversationListQuerySchema.shape.scope.safeParse(value);

  return parsed.success ? parsed.data : 'assigned';
}

function parseStatus(value: string | undefined): ConversationStatusFilter | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = ConversationListQuerySchema.shape.status.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}
