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
  ChatbotPipelineSection,
  ChatbotPipelineSectionSkeleton,
} from '@/features/chatbot/components/ChatbotPipelineSection';
import { ChatbotSettingsFormSkeleton } from '@/features/chatbot/components/ChatbotSettingsForm.Skeleton';
import { ChatbotSettingsSection } from '@/features/chatbot/components/ChatbotSettingsSection';
import { KnowledgeBaseSection } from '@/features/chatbot/components/KnowledgeBaseSection';
import { KnowledgeDocumentsTableSkeleton } from '@/features/chatbot/components/KnowledgeDocumentsTable';
import { KnowledgeFilterBarSkeleton } from '@/features/chatbot/components/KnowledgeFilterBar.Skeleton';
import { KnowledgeFilterSection } from '@/features/chatbot/components/KnowledgeFilterSection';
import { KnowledgeDocumentsPanel } from '@/features/chatbot/components/KnowledgeDocumentsPanel';
import { SourceHealthSection } from '@/features/chatbot/components/SourceHealthSection';
import { SourceHealthStripSkeleton } from '@/features/chatbot/components/SourceHealthStrip';
import { CHATBOT_PERMISSIONS } from '@/features/chatbot/constants';
import { loadKnowledgeDocuments } from '@/features/chatbot/chatbot.data';
import { parseKnowledgeListParams } from '@/features/chatbot/knowledge-params';

/**
 * The AI chatbot settings surface (TAR-28), rebuilt as a picture of the decision
 * the bot actually makes (TAR-813): a pipeline band, then one card per stage of
 * it — sources, when it may answer, how sure it has to be, what it says.
 * Composition only: gate, header, and independently-failing regions.
 *
 * **The order on the page is the order the bot runs**, and the rail in the first
 * card links into the four below it. That is the whole idea: the surface is not
 * a list of settings grouped by theme, it is the path a message takes with each
 * gate editable where it sits.
 *
 * **It is not a flow-chart canvas, and it will not become one.** The four stages
 * are fixed by ADR 0010's decision order — there is nothing to add, connect or
 * branch, because the chatbot answers from a knowledge base through an LLM
 * rather than following authored conversation paths.
 *
 * Gated on either permission rather than on `ai:write`, so a principal who may
 * read the configuration gets a read-only surface instead of a 403.
 * `settingsNavItems` hides the entry on the same rule. Both are UX; the API
 * enforces each endpoint independently. Searching is reading, so the filter row
 * is not gated further.
 *
 * ## Why so many boundaries, and only one key
 *
 * This is the only filtered list in the console that shares a page with a
 * stateful form, and the split exists to keep the two apart:
 *
 * - **The settings form** is unkeyed, so a filter change reconciles it in place
 *   rather than remounting it — an admin's unsaved system prompt survives a
 *   search in the card above.
 * - **The filter bar** is unkeyed for the same reason at a smaller scale: a key
 *   change remounts a subtree unconditionally, which would destroy the search
 *   box's draft and the caret on every debounce tick.
 * - **The result set** is keyed on the filters, so a filter change falls back to
 *   the table's skeleton instead of leaving stale rows under a new filter.
 * - **The health strip** is its own boundary and unkeyed: it counts the whole
 *   knowledge base rather than the filtered page, so it does not change when the
 *   filter does and must not blink when it doesn't.
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
        <Suspense fallback={<ChatbotPipelineSectionSkeleton />}>
          <ChatbotPipelineSection />
        </Suspense>
      </SectionErrorBoundary>

      {/* Stage A. Its own boundary: a failed sources read no longer costs the
          reader the rail above it and the settings below. */}
      <SectionErrorBoundary>
        <KnowledgeBaseSection checker={session.checker}>
          <Suspense fallback={<SourceHealthStripSkeleton />}>
            <SourceHealthSection filters={filters} />
          </Suspense>

          <Suspense fallback={<KnowledgeFilterBarSkeleton />}>
            <KnowledgeFilterSection documentsPromise={documentsPromise} isFiltered={isFiltered} />
          </Suspense>

          <Suspense
            key={`${filters.status ?? ''}:${filters.q ?? ''}`}
            fallback={<KnowledgeDocumentsTableSkeleton isFiltered={isFiltered} />}
          >
            <KnowledgeDocumentsPanel
              documentsPromise={documentsPromise}
              filters={filters}
              checker={session.checker}
            />
          </Suspense>
        </KnowledgeBaseSection>
      </SectionErrorBoundary>

      {/* Stages B, C and D — three cards, one form, one `PATCH /ai/config`. */}
      <SectionErrorBoundary>
        <Suspense fallback={<ChatbotSettingsFormSkeleton />}>
          <ChatbotSettingsSection checker={session.checker} />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
