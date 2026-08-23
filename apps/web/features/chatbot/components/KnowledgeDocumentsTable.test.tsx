import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { KnowledgeDocumentListItem } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { KnowledgeListParams } from '../knowledge-params';
import { KnowledgeDocumentsTable } from './KnowledgeDocumentsTable';

/*
 * The table refetches itself while an entry is indexing (`useIndexingRefresh`),
 * and `useRouter` throws outside a mounted app router. Only that hook is
 * replaced — `MenuButton` reads the real `usePathname` to close on navigation.
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

/**
 * TAR-28's first acceptance criterion in the admin surface: the entries the
 * chatbot may answer from are listed, each with the state that decides whether
 * it is usable — and the empty case says what the emptiness costs.
 */

function document(overrides: Partial<KnowledgeDocumentListItem> = {}): KnowledgeDocumentListItem {
  return {
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
    ...overrides,
  };
}

function renderTable(
  documents: readonly KnowledgeDocumentListItem[],
  {
    canWrite = true,
    filters = { q: undefined, status: undefined },
    indexedEntryCount = documents.filter((entry) => entry.status === 'indexed').length,
  }: {
    canWrite?: boolean;
    filters?: KnowledgeListParams;
    indexedEntryCount?: number;
  } = {},
) {
  return render(
    <ToastProvider>
      <KnowledgeDocumentsTable
        documents={documents}
        indexedEntryCount={indexedEntryCount}
        canWrite={canWrite}
        filters={filters}
      />
    </ToastProvider>,
  );
}

describe('KnowledgeDocumentsTable', () => {
  it('lists an entry with its status and how many pieces it was split into', () => {
    renderTable([document()]);

    expect(screen.getByText('Returns and refunds policy')).toBeInTheDocument();
    expect(screen.getByText(content.chatbot.statuses.indexed)).toBeInTheDocument();
    expect(screen.getByText(content.chatbot.chunkCount(3))).toBeInTheDocument();
  });

  it('explains an empty knowledge base rather than showing a blank panel', () => {
    // The chatbot stays quiet with nothing here, and an admin reading a blank
    // table would take that for a fault rather than the design (ADR 0010).
    renderTable([]);

    expect(screen.getByText(content.chatbot.knowledgeEmptyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.chatbot.knowledgeEmptyBody)).toBeInTheDocument();
  });

  it('quotes back the search term that matched nothing', () => {
    // TAR-613: the same blank table means two different things, and only one of
    // them is fixed by clearing a filter. TAR-813 splits the filtered half in
    // two again — a term that matched nothing and a status nothing is in are not
    // the same fact and do not have the same way out.
    renderTable([], { filters: { q: 'refunds', status: undefined } });

    expect(
      screen.getByText(content.chatbot.knowledgeSearchEmptyHeading('refunds')),
    ).toBeInTheDocument();
    expect(screen.queryByText(content.chatbot.knowledgeEmptyHeading)).not.toBeInTheDocument();
  });

  it('keeps the status filter when it offers to clear the search', () => {
    // Clearing a search is asking to stop searching, not asking to see
    // everything — dropping the status too would undo a filter nobody touched.
    renderTable([], { filters: { q: 'refunds', status: 'failed' } });

    expect(
      screen.getByRole('link', { name: content.chatbot.knowledgeClearSearch }),
    ).toHaveAttribute('href', routes.settingsChatbot({ status: 'failed' }));
  });

  it('names the status nothing is in, and says whether that is good news', () => {
    renderTable([], { filters: { q: undefined, status: 'failed' } });

    expect(
      screen.getByText(content.chatbot.knowledgeStatusEmptyHeadings.failed),
    ).toBeInTheDocument();
    expect(screen.getByText(content.chatbot.knowledgeStatusEmptyBodies.failed)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: content.chatbot.knowledgeShowAllSources }),
    ).toHaveAttribute('href', routes.settingsChatbot());
  });

  it('says why an entry failed to index, on the row', () => {
    // The chatbot silently ignores a failed entry, so a reason hidden behind a
    // tooltip is an entry that looks present and is not.
    renderTable([
      document({
        status: 'failed',
        chunkCount: 0,
        indexError: 'The document produced no usable text to index.',
      }),
    ]);

    expect(screen.getByText(/The document produced no usable text to index\./)).toBeInTheDocument();
  });

  it('offers no row actions to a reader who may not write', () => {
    renderTable([document()], { canWrite: false });

    expect(
      screen.queryByRole('button', {
        name: content.chatbot.editEntryAria('Returns and refunds policy'),
      }),
    ).not.toBeInTheDocument();
  });

  it('gives each row action the entry’s name, so a screen reader can tell them apart', () => {
    renderTable([
      document(),
      document({ id: '0192f010-0000-7000-8000-000000001002', title: 'Delivery times' }),
    ]);

    openOverflow('Delivery times');

    expect(
      screen.getByRole('button', { name: content.chatbot.deleteEntryAria('Delivery times') }),
    ).toBeInTheDocument();
  });
});

/**
 * The only cluster in the app with three actions, and the reason 0001's ladder
 * has a rule for it: `Edit` stays on the row, `Index again` and `Delete` go
 * behind the overflow, and the destructive one is last (TAR-709).
 */
describe('the row action ladder', () => {
  const TITLE = 'Returns and refunds policy';

  it('keeps only the most-used action inline', () => {
    renderTable([document()]);

    expect(
      screen.getByRole('button', { name: content.chatbot.editEntryAria(TITLE) }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.chatbot.reindexAria(TITLE) }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.chatbot.deleteEntryAria(TITLE) }),
    ).not.toBeInTheDocument();
  });

  it('puts the rest in an overflow named after the entry, destructive last', () => {
    renderTable([document()]);
    openOverflow(TITLE);

    const entries = screen
      .getAllByRole('button')
      .map((control) => control.getAttribute('aria-label'));

    expect(entries).toContain(content.chatbot.reindexAria(TITLE));
    expect(entries.at(-1)).toBe(content.chatbot.deleteEntryAria(TITLE));
  });
});

/**
 * The delete warning is the one place this table makes a claim about the whole
 * knowledge base rather than about the rows it is showing, and the table shows
 * one page of up to a thousand entries. Counting the page would tell an admin
 * that automated replies are about to stop when they are not.
 *
 * `fireEvent` rather than `user-event`: the repo does not carry that package.
 */
describe('the last-indexed-entry warning', () => {
  const TITLE = 'Returns and refunds policy';

  function openDelete() {
    openOverflow(TITLE);
    fireEvent.click(screen.getByRole('button', { name: content.chatbot.deleteEntryAria(TITLE) }));
  }

  it('warns when this is the tenant’s only indexed entry', async () => {
    renderTable([document()], { indexedEntryCount: 1 });
    openDelete();

    await expect(
      screen.findByText(content.chatbot.deleteLastBody(TITLE)),
    ).resolves.toBeInTheDocument();
  });

  it('does not warn when the tenant holds indexed entries beyond this page', async () => {
    // One indexed row on screen, forty in the knowledge base — the case a
    // page-local count got backwards, claiming automated replies were about to
    // stop when thirty-nine entries were still answering.
    renderTable([document()], { indexedEntryCount: 40 });
    openDelete();

    await expect(screen.findByText(content.chatbot.deleteBody(TITLE))).resolves.toBeInTheDocument();
  });

  it('does not warn over an entry the chatbot cannot answer from anyway', async () => {
    renderTable([document({ status: 'failed', chunkCount: 0 })], { indexedEntryCount: 1 });
    openDelete();

    await expect(screen.findByText(content.chatbot.deleteBody(TITLE))).resolves.toBeInTheDocument();
  });
});

/** `Delete` and `Index again` live behind the row's overflow trigger. */
function openOverflow(title: string): void {
  fireEvent.click(screen.getByRole('button', { name: content.common.rowActions(title) }));
}
