import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KnowledgeDocumentListItem, KnowledgeDocumentResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { KnowledgeEntryDialog } from './KnowledgeEntryDialog';

const loadKnowledgeEntryAction =
  vi.fn<(documentId: string) => Promise<ActionResult<KnowledgeDocumentResponse>>>();

vi.mock('@/features/chatbot/chatbot.actions', () => ({
  loadKnowledgeEntryAction: (documentId: string) => loadKnowledgeEntryAction(documentId),
  createKnowledgeEntryAction: () => Promise.resolve({ status: 'success', data: { title: '' } }),
  updateKnowledgeEntryAction: () => Promise.resolve({ status: 'success', data: { title: '' } }),
}));

/**
 * The read the editor cannot skip (TAR-528).
 *
 * The list endpoint omits `content`, so the row the table holds cannot fill the
 * editor. A form prefilled from it would show an empty text area and save that
 * emptiness back over the entry — which is the failure these tests exist to
 * stop coming back.
 */

const ROW: KnowledgeDocumentListItem = {
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

const ENTRY: KnowledgeDocumentResponse = {
  ...ROW,
  content: 'Unopened items can be returned within 30 days of delivery.',
};

function renderDialog(document?: KnowledgeDocumentListItem) {
  return render(
    <ToastProvider>
      <KnowledgeEntryDialog document={document} onClose={() => undefined} />
    </ToastProvider>,
  );
}

describe('KnowledgeEntryDialog', () => {
  beforeEach(() => {
    loadKnowledgeEntryAction.mockReset();
  });

  it('reads the entry it was opened on and fills the editor with its text', async () => {
    loadKnowledgeEntryAction.mockResolvedValue({ status: 'success', data: ENTRY });

    renderDialog(ROW);

    // The labels are already on screen while the read is in flight: the
    // skeleton mirrors the fields rather than blanking the dialog.
    expect(screen.getByText(content.chatbot.entryTitleLabel)).toBeInTheDocument();

    expect(await screen.findByDisplayValue(ENTRY.content)).toBeInTheDocument();
    expect(screen.getByDisplayValue(ENTRY.title)).toBeInTheDocument();
    expect(loadKnowledgeEntryAction).toHaveBeenCalledWith(ROW.id);
  });

  it('reads nothing when adding, because there is no entry yet', () => {
    renderDialog();

    expect(loadKnowledgeEntryAction).not.toHaveBeenCalled();
    expect(screen.getByText(content.chatbot.createTitle)).toBeInTheDocument();
  });

  it('offers a retry rather than an empty editor when the read fails', async () => {
    loadKnowledgeEntryAction.mockResolvedValueOnce({
      status: 'error',
      message: content.chatbot.editLoadFailed,
      requestId: null,
    });
    loadKnowledgeEntryAction.mockResolvedValue({ status: 'success', data: ENTRY });

    renderDialog(ROW);

    expect(await screen.findByText(content.chatbot.editLoadFailed)).toBeInTheDocument();
    // No fields behind the failure: an empty editor is the shape that would
    // save its emptiness back over the entry.
    expect(screen.queryByLabelText(content.chatbot.entryContentLabel)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: content.chatbot.editLoadRetry }));

    await waitFor(() => {
      expect(screen.getByDisplayValue(ENTRY.content)).toBeInTheDocument();
    });
  });
});
