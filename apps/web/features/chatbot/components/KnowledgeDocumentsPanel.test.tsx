import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AiConfigResponse, KnowledgeDocumentListItem } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { createPermissionChecker } from '@/lib/session/permissions';
import type { PermissionChecker } from '@/lib/session/permissions';
import type { KnowledgeDocumentsData } from '../chatbot.data';
import type { KnowledgeListParams } from '../knowledge-params';
import { CHATBOT_PERMISSIONS, KNOWLEDGE_DOCUMENTS_PAGE_SIZE } from '../constants';
import { KnowledgeDocumentsPanel } from './KnowledgeDocumentsPanel';

/**
 * The panel's own two decisions, which nothing else on the surface makes:
 * whether the truncation notice is on screen and *which* of its two sentences it
 * says, and whether a reader may write to the table below it.
 *
 * The notice is worth a test of its own (TAR-780). It cannot be reached by
 * clicking: the mock tenant holds four entries against a page size of ten, so
 * `hasMoreDocuments` is false everywhere in the mock-backed app, and TAR-613's
 * acceptance criterion for it was met by reading the source. Invert the
 * condition or swap the two sentences and nothing else in this repository
 * notices. These three cases do.
 *
 * The panel is an async server component, so it is awaited and its element
 * rendered — there is no client boundary to mount it behind.
 */

vi.mock('../chatbot.data', () => ({
  loadChatbotConfig: () => Promise.resolve(currentConfig),
}));

/*
 * The table below the notice refetches itself while an entry is indexing
 * (`useIndexingRefresh`), and its row actions call server actions. Both are the
 * table's own business, asserted in `KnowledgeDocumentsTable.test.tsx`.
 */
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock('@/features/chatbot/chatbot.actions', () => ({
  reindexKnowledgeEntryAction: () => Promise.resolve({ status: 'success', data: { title: '' } }),
  deleteKnowledgeEntryAction: () => Promise.resolve({ status: 'success', data: { title: '' } }),
  createKnowledgeEntryAction: () => Promise.resolve({ status: 'success', data: { title: '' } }),
  updateKnowledgeEntryAction: () => Promise.resolve({ status: 'success', data: { title: '' } }),
}));

const DOCUMENT: KnowledgeDocumentListItem = {
  id: '0192f010-0000-7000-8000-000000001001',
  title: 'Returns and refunds policy',
  sourceUrl: null,
  language: 'en',
  status: 'indexed',
  chunkCount: 3,
  indexError: null,
  indexedAt: '2026-08-01T09:05:00.000Z',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:05:00.000Z',
};

function chatbotConfig(readiness: Partial<AiConfigResponse['readiness']> = {}): AiConfigResponse {
  return {
    isEnabled: true,
    model: null,
    minConfidence: 0.6,
    maxBotTurns: 3,
    systemPrompt: null,
    handoffMessage: null,
    handoffKeywords: [],
    availableModels: [],
    readiness: { ready: true, indexedDocumentCount: 12, blockers: [], ...readiness },
    updatedAt: '2026-08-01T09:05:00.000Z',
  };
}

let currentConfig = chatbotConfig();

const TRUNCATED: KnowledgeDocumentsData = { documents: [DOCUMENT], hasMoreDocuments: true };
const COMPLETE: KnowledgeDocumentsData = { documents: [DOCUMENT], hasMoreDocuments: false };

const ADMIN = createPermissionChecker([CHATBOT_PERMISSIONS.read, CHATBOT_PERMISSIONS.write]);
const READER = createPermissionChecker([CHATBOT_PERMISSIONS.read]);

async function renderPanel(
  data: KnowledgeDocumentsData,
  {
    filters = { q: undefined, status: undefined },
    checker = ADMIN,
  }: { filters?: KnowledgeListParams; checker?: PermissionChecker } = {},
) {
  return render(
    <ToastProvider>
      {await KnowledgeDocumentsPanel({
        documentsPromise: Promise.resolve(data),
        filters,
        checker,
      })}
    </ToastProvider>,
  );
}

/** Any filter at all: which one it is does not change the truncation notice. */
const FILTERED: KnowledgeListParams = { q: 'refunds', status: undefined };

function unfilteredNotice() {
  return content.chatbot.knowledgeShowingFirst(KNOWLEDGE_DOCUMENTS_PAGE_SIZE);
}

function filteredNotice() {
  return content.chatbot.knowledgeShowingFirstFiltered(KNOWLEDGE_DOCUMENTS_PAGE_SIZE);
}

beforeEach(() => {
  currentConfig = chatbotConfig();
});

describe('KnowledgeDocumentsPanel', () => {
  it('says the list is the most recent page, and points at the filters that reach the rest', async () => {
    await renderPanel(TRUNCATED);

    expect(screen.getByText(unfilteredNotice())).toBeInTheDocument();
    expect(screen.queryByText(filteredNotice())).not.toBeInTheDocument();
  });

  it('asks for a narrower search when the entries that overflow are already a filtered set', async () => {
    // A reader who has searched has been told once already that filtering is how
    // to reach the others; repeating it would read as the filter not working.
    await renderPanel(TRUNCATED, { filters: FILTERED });

    expect(screen.getByText(filteredNotice())).toBeInTheDocument();
    expect(screen.queryByText(unfilteredNotice())).not.toBeInTheDocument();
  });

  it('says nothing when the whole list is on screen, filtered or not', async () => {
    // Silence is honest here: a complete list has no "others" to reach, and a
    // standing caption above the search box would be noise on every visit.
    const { unmount } = await renderPanel(COMPLETE);

    expect(screen.queryByText(unfilteredNotice())).not.toBeInTheDocument();
    expect(screen.queryByText(filteredNotice())).not.toBeInTheDocument();

    unmount();
    await renderPanel(COMPLETE, { filters: FILTERED });

    expect(screen.queryByText(unfilteredNotice())).not.toBeInTheDocument();
    expect(screen.queryByText(filteredNotice())).not.toBeInTheDocument();
  });

  it('offers no row actions to a reader who may not write', async () => {
    await renderPanel(TRUNCATED, { checker: READER });

    expect(
      screen.queryByRole('button', { name: content.chatbot.editEntryAria(DOCUMENT.title) }),
    ).not.toBeInTheDocument();
  });

  it('offers no row actions when the plan does not carry the chatbot, whatever the role', async () => {
    // The permission is the tenant's answer to "may this person write", and the
    // plan is a separate answer to "may anyone here". An admin on a plan without
    // the feature gets a table they can read, not controls the API would refuse.
    currentConfig = chatbotConfig({ ready: false, blockers: ['feature_not_in_plan'] });

    await renderPanel(TRUNCATED);

    expect(
      screen.queryByRole('button', { name: content.chatbot.editEntryAria(DOCUMENT.title) }),
    ).not.toBeInTheDocument();
  });
});
