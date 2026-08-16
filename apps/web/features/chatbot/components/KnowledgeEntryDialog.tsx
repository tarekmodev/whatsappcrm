'use client';

import type { KnowledgeDocumentListItem } from '@whatsappcrm/contracts';
import { FormDialog } from '@/components/ui/FormDialog';
import { useContent } from '@/lib/content';
import { useKnowledgeEntry } from '../useKnowledgeEntry';
import { KnowledgeEntryForm } from './KnowledgeEntryForm';
import { KnowledgeEntryFormSkeleton } from './KnowledgeEntryForm.Skeleton';

/**
 * The knowledge base entry editor. Usage: `<KnowledgeEntryDialog onClose={…} />`
 * to add, or with `document` — the table's row — to edit that entry.
 *
 * Adding needs nothing but the form. **Editing needs one read first**: the list
 * endpoint omits `content`, because a page of entries each holding up to 256 KiB
 * is a response nobody wants, so the row the table holds cannot fill the editor.
 * A form prefilled from it would show an empty text area and save that emptiness
 * back over the entry — which is why the fetch is here rather than optional.
 *
 * The form mounts only once the entry has arrived, so its fields initialise from
 * real values rather than syncing to them afterwards.
 */
export function KnowledgeEntryDialog({
  document,
  onClose,
}: {
  /** Omitted to add a new entry; the table's row to edit that one. */
  document?: KnowledgeDocumentListItem;
  onClose: () => void;
}) {
  if (document === undefined) {
    return <KnowledgeEntryForm onClose={onClose} />;
  }

  return <EditKnowledgeEntryDialog documentId={document.id} onClose={onClose} />;
}

/**
 * Its own component so the hook runs only on the editing path — a dialog opened
 * to *add* an entry has nothing to read, and a conditional hook is not an
 * option.
 */
function EditKnowledgeEntryDialog({
  documentId,
  onClose,
}: {
  documentId: string;
  onClose: () => void;
}) {
  const content = useContent();
  const entry = useKnowledgeEntry(documentId);

  if (entry.status === 'ready') {
    return <KnowledgeEntryForm entry={entry.entry} onClose={onClose} />;
  }

  return (
    <FormDialog
      isOpen
      title={content.chatbot.editTitle}
      description={content.chatbot.editDescription}
      // The failed read is retried from the submit button rather than from a
      // second control: it is the one action left, and the dialog's own footer
      // is where the reader is already looking.
      submitLabel={
        entry.status === 'error' ? content.chatbot.editLoadRetry : content.chatbot.editSubmit
      }
      isPending={entry.status === 'loading'}
      formError={entry.status === 'error' ? entry.message : null}
      isSubmitDisabled={entry.status === 'loading'}
      onClose={onClose}
      onSubmit={entry.retry}
    >
      {/* No fields behind a failed read: an empty editor is the shape that
          would save its emptiness back over the entry. */}
      {entry.status === 'error' ? null : <KnowledgeEntryFormSkeleton />}
    </FormDialog>
  );
}
