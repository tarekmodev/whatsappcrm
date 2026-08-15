'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { KnowledgeDocumentResponse } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useToast } from '@/components/ui/ToastProvider';
import { Cluster } from '@/components/layout/Cluster';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { reindexKnowledgeEntryAction } from '../chatbot.actions';
import { KNOWLEDGE_DOCUMENTS_PAGE_SIZE } from '../constants';
import { KNOWLEDGE_STATUS_TONES } from '../presentation';
import { knowledgeColumnMeta } from './knowledge-columns';
import { LazyDeleteKnowledgeEntryDialog, LazyKnowledgeEntryDialog } from './knowledge-dialogs.lazy';
import styles from './KnowledgeDocumentsTable.module.css';

/**
 * The knowledge base, as a table. Usage:
 * `<KnowledgeDocumentsTable documents={documents} canWrite />`.
 *
 * A client component because the row actions open dialogs; the data is fetched
 * on the server and passed in, so no client-side waterfall is introduced.
 *
 * **A failed entry says why on the row**, under the title, rather than behind a
 * tooltip: the chatbot silently ignores it, so an admin who cannot see the
 * reason has an entry that looks present and is not.
 *
 * Row actions are real buttons and always visible. A hover-only action is
 * unreachable by touch and by keyboard, and this table's rows stack into cards
 * below the layout breakpoint where there is no hover at all.
 */

export interface KnowledgeDocumentsTableProps {
  documents: readonly KnowledgeDocumentResponse[];
  canWrite: boolean;
}

export function KnowledgeDocumentsTable({ documents, canWrite }: KnowledgeDocumentsTableProps) {
  const content = useContent();
  const [editing, setEditing] = useState<KnowledgeDocumentResponse | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeDocumentResponse | null>(null);

  const columns = useMemo<DataTableColumn<KnowledgeDocumentResponse>[]>(() => {
    const renderers: Record<string, (document: KnowledgeDocumentResponse) => ReactNode> = {
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
        <Cluster gap="1" justify="end" className={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            aria-label={content.chatbot.editEntryAria(document.title)}
            onClick={() => {
              setEditing(document);
            }}
          >
            {content.chatbot.editEntry}
          </Button>
          <ReindexButton document={document} />
          <Button
            size="sm"
            variant="ghost"
            aria-label={content.chatbot.deleteEntryAria(document.title)}
            onClick={() => {
              setDeleting(document);
            }}
          >
            {content.chatbot.deleteEntry}
          </Button>
        </Cluster>
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
        heading={content.chatbot.knowledgeEmptyHeading}
        body={content.chatbot.knowledgeEmptyBody}
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
          isLastIndexedEntry={isLastIndexedEntry(documents, deleting)}
          onClose={() => {
            setDeleting(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The one action that is a direct mutation rather than a dialog.
 *
 * Re-indexing is not destructive and asks nothing of the user, so a confirmation
 * would be a click for its own sake. Its own component because it needs its own
 * pending state — two rows re-indexing at once must show two spinners, not one
 * shared between them.
 */
function ReindexButton({ document }: { document: KnowledgeDocumentResponse }) {
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
    <Button
      size="sm"
      variant="secondary"
      isPending={isPending}
      aria-label={content.chatbot.reindexAria(document.title)}
      onClick={() => {
        submit();
      }}
    >
      {content.chatbot.reindex}
    </Button>
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
 */
function isLastIndexedEntry(
  documents: readonly KnowledgeDocumentResponse[],
  candidate: KnowledgeDocumentResponse,
): boolean {
  if (candidate.status !== 'indexed') {
    return false;
  }

  return documents.filter((document) => document.status === 'indexed').length === 1;
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
