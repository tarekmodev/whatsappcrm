import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { KnowledgeDocumentListItem } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { KnowledgeDocumentsTable } from './KnowledgeDocumentsTable';

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
  { canWrite = true }: { canWrite?: boolean } = {},
) {
  return render(
    <ToastProvider>
      <KnowledgeDocumentsTable documents={documents} canWrite={canWrite} />
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

    expect(
      screen.getByRole('button', { name: content.chatbot.deleteEntryAria('Delivery times') }),
    ).toBeInTheDocument();
  });
});
