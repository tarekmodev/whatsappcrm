import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { INBOX_SCOPES, searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { verifySession } from '@/lib/session/session';
import { isConversationScopeNarrowed } from '@/lib/session/permissions';
import { webEnv } from '@/lib/config/env';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { InboxScopeTabs } from '@/features/inbox/components/InboxScopeTabs';
import { InboxPanes } from '@/features/inbox/components/InboxPanes';
import { InboxRealtime } from '@/features/inbox/components/InboxRealtime';
import { InboxSection, InboxSectionSkeleton } from '@/features/inbox/components/InboxSection';
import { NoThreadSelected } from '@/features/inbox/components/NoThreadSelected';
import { ThreadSection, ThreadSectionSkeleton } from '@/features/inbox/components/ThreadSection';
import { parseInboxParams } from '@/features/inbox/inbox-params';

/**
 * The shared inbox: the conversation list beside the open thread. Composition
 * only.
 *
 * Scope, status filter and the open conversation all live in the URL, so a
 * refresh, a copied link and the back button reproduce the same view. The list
 * and the thread sit in separate Suspense and error boundaries — a thread that
 * fails to load must not take the list down with it, and each shows its own
 * skeleton while it waits.
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
  const { scope, status, conversationId } = parseInboxParams({
    scope: firstSearchParam(params[searchParamKeys.inboxScope]),
    status: firstSearchParam(params[searchParamKeys.inboxStatus]),
    conversationId: firstSearchParam(params[searchParamKeys.inboxConversation]),
  });

  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.inbox.title} />
        <InboxScopeTabs
          availableScopes={INBOX_SCOPES}
          activeScope={scope}
          activeStatus={status}
          activeConversationId={conversationId}
        />

        <InboxPanes
          hasThread={conversationId !== null}
          list={
            <SectionErrorBoundary>
              {/* Keyed on the filters so changing one shows the skeleton again
                  rather than leaving the previous scope's rows on screen. */}
              <Suspense
                key={`${scope}:${status ?? ''}`}
                fallback={<InboxSectionSkeleton hasClaim={checker.can('conversation:assign')} />}
              >
                <InboxSection
                  query={{ scope, status }}
                  selectedId={conversationId}
                  isScopeNarrowed={isConversationScopeNarrowed(checker, scope)}
                />
              </Suspense>
            </SectionErrorBoundary>
          }
          thread={
            conversationId === null ? (
              <NoThreadSelected />
            ) : (
              <SectionErrorBoundary>
                <Suspense
                  key={conversationId}
                  fallback={<ThreadSectionSkeleton query={{ scope, status }} />}
                >
                  <ThreadSection conversationId={conversationId} query={{ scope, status }} />
                </Suspense>
              </SectionErrorBoundary>
            )
          }
        />
      </Stack>

      <InboxRealtime isEnabled={!webEnv.useMockApi} conversationId={conversationId} />
    </PageShell>
  );
}
