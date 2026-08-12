import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { verifySession } from '@/lib/session/session';
import { isConversationScopeNarrowed } from '@/lib/session/permissions';
import { webEnv } from '@/lib/config/env';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { InboxContextPanelSkeleton } from '@/features/inbox/components/InboxContextPanel';
import { InboxContextSection } from '@/features/inbox/components/InboxContextSection';
import { InboxFilterNav } from '@/features/inbox/components/InboxFilterNav';
import { InboxLayout } from '@/features/inbox/components/InboxLayout';
import { InboxRealtime } from '@/features/inbox/components/InboxRealtime';
import { InboxSection, InboxSectionSkeleton } from '@/features/inbox/components/InboxSection';
import { NoThreadSelected } from '@/features/inbox/components/NoThreadSelected';
import { ThreadSection, ThreadSectionSkeleton } from '@/features/inbox/components/ThreadSection';
import { parseInboxParams } from '@/features/inbox/inbox-params';

/**
 * The shared inbox: filters, the conversation list, the open thread, and the
 * context panel beside it. Composition only.
 *
 * Scope, status filter, search term and the open conversation all live in the
 * URL, so a refresh, a copied link and the back button reproduce the same view.
 * The list, the thread and the context panel sit in separate Suspense and error
 * boundaries — a thread that fails to load must not take the list down with it,
 * and each shows its own skeleton while it waits.
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
  const { scope, status, conversationId, q } = parseInboxParams({
    scope: firstSearchParam(params[searchParamKeys.inboxScope]),
    status: firstSearchParam(params[searchParamKeys.inboxStatus]),
    conversationId: firstSearchParam(params[searchParamKeys.inboxConversation]),
    q: firstSearchParam(params[searchParamKeys.inboxQuery]),
  });
  const threadQuery = { scope, status, q };

  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={q === undefined ? content.inbox.title : content.search.resultsFor(q)} />

        <InboxLayout
          hasThread={conversationId !== null}
          filters={
            <InboxFilterNav
              scope={scope}
              status={status}
              conversationId={conversationId}
              canManageChannels={checker.can('channel:manage')}
            />
          }
          list={
            <SectionErrorBoundary>
              {/* Keyed on the filters so changing one shows the skeleton again
                  rather than leaving the previous scope's rows on screen. */}
              <Suspense
                key={`${scope}:${status ?? ''}:${q ?? ''}`}
                fallback={
                  // Either permission puts a control on some row, and the
                  // skeleton reserves its height so nothing shifts when the data
                  // lands. Since TAR-186 an agent has one too.
                  <InboxSectionSkeleton
                    hasClaim={checker.canAny(['conversation:claim', 'conversation:assign'])}
                  />
                }
              >
                <InboxSection
                  query={{ scope, status, q }}
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
                  fallback={<ThreadSectionSkeleton query={threadQuery} />}
                >
                  <ThreadSection conversationId={conversationId} query={threadQuery} />
                </Suspense>
              </SectionErrorBoundary>
            )
          }
          context={
            conversationId === null ? null : (
              <SectionErrorBoundary>
                <Suspense key={conversationId} fallback={<InboxContextPanelSkeleton />}>
                  <InboxContextSection conversationId={conversationId} />
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
