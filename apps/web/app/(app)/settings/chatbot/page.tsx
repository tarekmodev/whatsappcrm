import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { requireAnyPermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  ChatbotConfigSections,
  ChatbotConfigSectionsSkeleton,
} from '@/features/chatbot/components/ChatbotConfigSections';
import { KnowledgeBaseSection } from '@/features/chatbot/components/KnowledgeBaseSection';
import { KnowledgeDocumentsTableSkeleton } from '@/features/chatbot/components/KnowledgeDocumentsTable';
import { KnowledgeFilterBarSkeleton } from '@/features/chatbot/components/KnowledgeFilterBar.Skeleton';
import { KnowledgeFilterSection } from '@/features/chatbot/components/KnowledgeFilterSection';
import { KnowledgeDocumentsPanel } from '@/features/chatbot/components/KnowledgeDocumentsPanel';
import { CHATBOT_PERMISSIONS } from '@/features/chatbot/constants';
import { loadKnowledgeDocuments } from '@/features/chatbot/chatbot.data';
import { parseKnowledgeListParams } from '@/features/chatbot/knowledge-params';

/**
 * The AI chatbot settings surface (TAR-28): whether it is answering, the
 * settings that decide when it does, and the knowledge base it answers from —
 * now searchable by title and filterable by indexing state (TAR-613).
 * Composition only: gate, header, and three independently-failing regions.
 *
 * Gated on either permission rather than on `ai:write`, so a principal who may
 * read the configuration gets a read-only surface instead of a 403.
 * `settingsNavItems` hides the entry on the same rule. Both are UX; the API
 * enforces each endpoint independently. Searching is reading, so the filter row
 * is not gated further.
 *
 * ## Why three boundaries and only one key
 *
 * This is the only filtered list in the console that shares a page with a
 * stateful form, and the split exists to keep the two apart:
 *
 * - **Config** is unkeyed, so a filter change reconciles it in place rather than
 *   remounting it — an admin's unsaved system prompt survives a search below.
 * - **The filter bar** is unkeyed for the same reason at a smaller scale: a key
 *   change remounts a subtree unconditionally, which would destroy the search
 *   box's draft and the caret on every debounce tick.
 * - **The result set** is keyed on the filters, so a filter change falls back to
 *   the table's skeleton instead of leaving stale rows under a new filter.
 *
 * The knowledge base card itself sits outside all of them: it awaits nothing, so
 * the two boundaries inside it can paint without waiting on `GET /ai/config`.
 */

export const metadata: Metadata = {
  title: `${content.chatbot.title} · ${content.app.name}`,
  description: content.chatbot.subtitle,
};

/** Resolves a live session, live readiness and a per-URL list; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

const CHATBOT_SETTINGS_PERMISSIONS = [CHATBOT_PERMISSIONS.read, CHATBOT_PERMISSIONS.write] as const;

export default async function ChatbotSettingsPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const session = await requireAnyPermission(CHATBOT_SETTINGS_PERMISSIONS);

  if (session === null) {
    return <ForbiddenState />;
  }

  const params = await searchParams;
  const filters = parseKnowledgeListParams({
    q: firstSearchParam(params[searchParamKeys.knowledgeQuery]),
    status: firstSearchParam(params[searchParamKeys.knowledgeStatus]),
  });
  const isFiltered = filters.q !== undefined || filters.status !== undefined;

  // Started here, before any component renders, so the request is already in
  // flight while the frame and the configuration read are still resolving. One
  // promise, two consumers — the filter bar's "is there anything to filter" and
  // the table's rows are answered by the same round trip.
  const documentsPromise = loadKnowledgeDocuments(filters);

  return (
    <Stack gap="5">
      <PageHeader title={content.chatbot.title} subtitle={content.chatbot.subtitle} />

      <SectionErrorBoundary>
        <Suspense fallback={<ChatbotConfigSectionsSkeleton />}>
          <ChatbotConfigSections checker={session.checker} />
        </Suspense>
      </SectionErrorBoundary>

      {/* Its own boundary: after the split, a failed knowledge read no longer
          costs the reader the readiness panel and the settings form. */}
      <SectionErrorBoundary>
        <KnowledgeBaseSection checker={session.checker}>
          <Suspense fallback={<KnowledgeFilterBarSkeleton />}>
            <KnowledgeFilterSection documentsPromise={documentsPromise} isFiltered={isFiltered} />
          </Suspense>

          <Suspense
            key={`${filters.status ?? ''}:${filters.q ?? ''}`}
            fallback={<KnowledgeDocumentsTableSkeleton isFiltered={isFiltered} />}
          >
            <KnowledgeDocumentsPanel
              documentsPromise={documentsPromise}
              isFiltered={isFiltered}
              checker={session.checker}
            />
          </Suspense>
        </KnowledgeBaseSection>
      </SectionErrorBoundary>
    </Stack>
  );
}
