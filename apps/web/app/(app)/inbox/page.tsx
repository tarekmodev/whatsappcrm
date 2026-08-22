import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { verifySession } from '@/lib/session/session';
import { isConversationScopeNarrowed } from '@/lib/session/permissions';
import { webEnv } from '@/lib/config/env';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { PageShell } from '@/components/shell/PageShell';
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
 *
 * `variant="fill"` because this is a workspace, not a document: the four regions
 * fill the space the top bar left and scroll inside it, so the composer is
 * always reachable. The `<h1>` is visually hidden with it — the screen said
 * "Inbox" three times over about 80px of vertical space, and the filter column's
 * own heading is the one worth keeping. The document outline still needs it.
 */

export const metadata: Metadata = {
  title: content.inbox.title,
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
  const { scope, status, conversationId, q, sort } = parseInboxParams({
    scope: firstSearchParam(params[searchParamKeys.inboxScope]),
    status: firstSearchParam(params[searchParamKeys.inboxStatus]),
    conversationId: firstSearchParam(params[searchParamKeys.inboxConversation]),
    q: firstSearchParam(params[searchParamKeys.inboxQuery]),
    sort: firstSearchParam(params[searchParamKeys.inboxSort]),
  });
  const listQuery = { scope, status, q, sort };
  const threadQuery = listQuery;

  return (
    <PageShell variant="fill">
      <VisuallyHidden as="h1">
        {q === undefined ? content.inbox.title : content.search.resultsFor(q)}
      </VisuallyHidden>

      <InboxLayout
        hasThread={conversationId !== null}
        filters={
          <InboxFilterNav
            scope={scope}
            status={status}
            conversationId={conversationId}
            sort={sort}
            canManageChannels={checker.can('channel:manage')}
          />
        }
        list={
          <SectionErrorBoundary>
            {/* Keyed on the filters and the order, so changing one shows the
                skeleton again rather than leaving the previous view's rows on
                screen in the previous view's order. */}
            <Suspense
              key={`${scope}:${status ?? ''}:${q ?? ''}:${sort}`}
              fallback={<InboxSectionSkeleton query={listQuery} selectedId={conversationId} />}
            >
              <InboxSection
                query={listQuery}
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

      <InboxRealtime isEnabled={!webEnv.useMockApi} conversationId={conversationId} />
    </PageShell>
  );
}
