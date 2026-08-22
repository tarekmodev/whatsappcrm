'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { KnowledgeDocumentListItem } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RowActions } from '@/components/ui/RowActions';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { reindexKnowledgeEntryAction } from '../chatbot.actions';
import { KNOWLEDGE_DOCUMENTS_PAGE_SIZE } from '../constants';
import { KNOWLEDGE_STATUS_TONES } from '../presentation';
import { useIndexingRefresh } from '../useIndexingRefresh';
import { knowledgeColumnMeta } from './knowledge-columns';
import { LazyDeleteKnowledgeEntryDialog, LazyKnowledgeEntryDialog } from './knowledge-dialogs.lazy';
import styles from './KnowledgeDocumentsTable.module.css';

/**
 * The knowledge base, as a table. Usage:
 * `<KnowledgeDocumentsTable documents={documents} indexedEntryCount={count} canWrite />`.
 *
 * A client component because the row actions open dialogs; the data is fetched
 * on the server and passed in, so no client-side waterfall is introduced.
 *
 * **A failed entry says why on the row**, under the title, rather than behind a
 * tooltip: the chatbot silently ignores it, so an admin who cannot see the
 * reason has an entry that looks present and is not.
 *
 * Row actions are real controls and always visible — never hover-only, which is
 * unreachable by touch and by keyboard, and these rows stack into cards below the
 * layout breakpoint where there is no hover at all. This is the one table with
 * three of them, so it is also the one that collapses: see `KnowledgeRowActions`.
 */

export interface KnowledgeDocumentsTableProps {
  documents: readonly KnowledgeDocumentListItem[];
  /**
   * How many indexed entries the **tenant** holds, from the readiness the API
   * publishes — not how many of them this page happens to show.
   */
  indexedEntryCount: number;
  canWrite: boolean;
}

export function KnowledgeDocumentsTable({
  documents,
  indexedEntryCount,
  canWrite,
}: KnowledgeDocumentsTableProps) {
  const content = useContent();
  const [editing, setEditing] = useState<KnowledgeDocumentListItem | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeDocumentListItem | null>(null);

  // `Indexing` settles into `Ready` or `Failed` within seconds, so the row that
  // says it refetches itself rather than waiting for somebody to press reload.
  useIndexingRefresh(documents.some((document) => document.status === 'pending'));

  const columns = useMemo<DataTableColumn<KnowledgeDocumentListItem>[]>(() => {
    const renderers: Record<string, (document: KnowledgeDocumentListItem) => ReactNode> = {
      title: (document) => (
        <div className={styles.title}>
          <p className={styles.titleText}>{document.title}</p>
          {document.indexError === null ? null : (
            <p className={styles.indexError}>
              {content.chatbot.indexFailedLabel}: {document.indexError}
            </p>
          )}
        </div>
      ),
      status: (document) => (
        <Badge tone={KNOWLEDGE_STATUS_TONES[document.status]}>
          {content.chatbot.statuses[document.status]}
        </Badge>
      ),
      chunks: (document) =>
        document.chunkCount === 0
          ? content.chatbot.chunkCountEmpty
          : content.chatbot.chunkCount(document.chunkCount),
      updated: (document) => (
        <RelativeTime isoTimestamp={document.updatedAt} label={content.chatbot.updatedAt} />
      ),
      actions: (document) => (
        <KnowledgeRowActions
          document={document}
          onEdit={() => {
            setEditing(document);
          }}
          onDelete={() => {
            setDeleting(document);
          }}
        />
      ),
    };

    return knowledgeColumnMeta(content, canWrite).map((meta) => ({
      ...meta,
      render: renderers[meta.key] ?? (() => null),
    }));
  }, [canWrite, content]);

  if (documents.length === 0) {
    return (
      <EmptyState
        icon="note"
        title={content.chatbot.knowledgeEmptyHeading}
        description={content.chatbot.knowledgeEmptyBody}
      />
    );
  }

  return (
    <>
      <DataTable
        caption={content.chatbot.knowledgeHeading}
        columns={columns}
        rows={documents}
        getRowKey={(document) => document.id}
        // Decoration only, and the row already says "Failed" in words beside it:
        // colour alone never carries the meaning.
        getRowTone={(document) => (document.status === 'failed' ? 'danger' : undefined)}
      />

      {/* Dialog chunks load on first open, not with the page. */}
      {editing === null ? null : (
        <LazyKnowledgeEntryDialog
          document={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      {deleting === null ? null : (
        <LazyDeleteKnowledgeEntryDialog
          document={deleting}
          // Whether this is the last thing the chatbot can answer from, which
          // changes the warning: deleting it switches automated replies off.
          isLastIndexedEntry={isLastIndexedEntry(indexedEntryCount, deleting)}
          onClose={() => {
            setDeleting(null);
          }}
        />
      )}
    </>
  );
}

/**
 * This table's row actions — the one cluster in the app with three of them.
 *
 * Three peers at row level is more than a reader can rank at a glance, so the
 * ladder in 0001 keeps only the most-used one inline and collapses the rest:
 * `Edit` on the row, `Index again` and `Delete` behind the overflow. `RowActions`
 * owns that rule; what belongs here is which action is the inline one.
 *
 * Its own component because re-indexing needs its own pending state — two rows
 * re-indexing at once must show two spinners, not one shared between them. Its
 * being a direct mutation rather than a dialog is also why it asks nothing first:
 * it is not destructive, so a confirmation would be a click for its own sake.
 */
function KnowledgeRowActions({
  document,
  onEdit,
  onDelete,
}: {
  document: KnowledgeDocumentListItem;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const content = useContent();
  const { showToast } = useToast();

  const perform = useCallback(
    async () => reindexKnowledgeEntryAction(document.id, document.title),
    [document.id, document.title],
  );

  const onSuccess = useCallback(
    ({ title }: { title: string }) => {
      showToast({ tone: 'success', message: content.chatbot.reindexSuccess(title) });
    },
    [content, showToast],
  );

  const { submit, isPending } = useActionForm({ perform, onSuccess });

  return (
    <RowActions
      subject={document.title}
      actions={[
        {
          key: 'edit',
          label: content.chatbot.editEntry,
          accessibleName: content.chatbot.editEntryAria(document.title),
          onSelect: onEdit,
        },
        {
          key: 'reindex',
          label: content.chatbot.reindex,
          accessibleName: content.chatbot.reindexAria(document.title),
          isPending,
          onSelect: () => {
            submit();
          },
        },
        {
          key: 'delete',
          label: content.chatbot.deleteEntry,
          accessibleName: content.chatbot.deleteEntryAria(document.title),
          isDestructive: true,
          onSelect: onDelete,
        },
      ]}
    />
  );
}

/**
 * Whether removing this entry would leave the chatbot with nothing to answer
 * from.
 *
 * Only `indexed` entries count, because only they are retrievable: a knowledge
 * base of three failed documents is an empty one as far as the bot is concerned,
 * and warning about the last *row* rather than the last *usable* row would tell
 * an admin the opposite of the truth.
 *
 * Counted **over the tenant** rather than over the rows on screen. This table
 * shows one page, so a page holding a single indexed entry says nothing about
 * how many the tenant has — and the warning it drives is the one that claims
 * automated replies are about to stop. `readiness.indexedDocumentCount` is the
 * same number the readiness panel above renders, read in the same server pass as
 * this list, so the two cannot disagree with each other.
 */
function isLastIndexedEntry(
  indexedEntryCount: number,
  candidate: KnowledgeDocumentListItem,
): boolean {
  return candidate.status === 'indexed' && indexedEntryCount === 1;
}

/**
 * Mirrors the loaded table exactly — it *is* the same table, with the same
 * columns and placeholder cells — so the swap to real data shifts nothing. Row
 * count matches the page size the server requests.
 */
export function KnowledgeDocumentsTableSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.chatbot.knowledgeLoading} />
      <DataTableSkeleton
        caption={content.chatbot.knowledgeHeading}
        rowCount={KNOWLEDGE_DOCUMENTS_PAGE_SIZE}
        columns={knowledgeColumnMeta(content, hasActions).map((meta) => ({
          ...meta,
          render: () => null,
        }))}
      />
    </>
  );
}
