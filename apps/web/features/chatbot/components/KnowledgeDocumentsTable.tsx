'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { KnowledgeDocumentListItem } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { DataTable, DataTableSkeleton, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RowActions } from '@/components/ui/RowActions';
import { TextLink } from '@/components/ui/TextLink';
import { useToast } from '@/components/ui/ToastProvider';
import { useActionForm } from '@/lib/hooks/useActionForm';
import { useContent } from '@/lib/content';
import { reindexKnowledgeEntryAction } from '../chatbot.actions';
import { routes } from '@/lib/routes';
import { KNOWLEDGE_DOCUMENTS_PAGE_SIZE, KNOWLEDGE_FILTERED_SKELETON_ROWS } from '../constants';
import type { KnowledgeListParams } from '../knowledge-params';
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
  /**
   * The filters this page was read with — the values, not just whether there
   * were any (TAR-813).
   *
   * Four empty states hang off this, and each needs something the boolean it
   * replaced could not supply: the term that matched nothing has to be quoted
   * back, the status nothing is in has to be named, and the way out of each is a
   * different link. Not optional, because a caller that could leave it out is a
   * caller that would show "no sources yet" over a filtered view.
   */
  filters: KnowledgeListParams;
}

export function KnowledgeDocumentsTable({
  documents,
  indexedEntryCount,
  canWrite,
  filters,
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
    return <KnowledgeEmptyState filters={filters} canWrite={canWrite} />;
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
/**
 * The four ways this table can be empty (TAR-813).
 *
 * They are four rather than one because they are four different facts with four
 * different ways out, and a single "nothing here" would be wrong for three of
 * them. A search that matched nothing quotes the term back and offers to clear
 * it. A status filter that matched nothing says what nothing is in — and an
 * empty `Failed` filter is good news where an empty `Ready` filter is the reason
 * the chatbot is silent, so each status brings its own sentence. A knowledge
 * base that has never had a source explains what the silence costs.
 *
 * A reader who cannot write gets that last one `quiet`: the tone is the
 * difference between "here is your next step" and "here is why it is empty, and
 * it is not yours to fix". No action either way — the `Add source` button in the
 * card header directly above is the next step, and a second one inside the state
 * would be the same control twice in one card.
 */
function KnowledgeEmptyState({
  filters,
  canWrite,
}: {
  filters: KnowledgeListParams;
  canWrite: boolean;
}) {
  const content = useContent();

  // The search is checked first because it is the narrower claim: with both
  // applied, the term is what the reader last typed and the thing they will
  // want back.
  if (filters.q !== undefined) {
    return (
      <EmptyState
        icon="search"
        title={content.chatbot.knowledgeSearchEmptyHeading(filters.q)}
        description={content.chatbot.knowledgeSearchEmptyBody}
        action={
          // Keeps the status filter: clearing a search is not asking to see
          // everything, it is asking to stop searching.
          <TextLink href={routes.settingsChatbot({ status: filters.status })}>
            {content.chatbot.knowledgeClearSearch}
          </TextLink>
        }
      />
    );
  }

  if (filters.status !== undefined) {
    return (
      <EmptyState
        icon="filter"
        title={content.chatbot.knowledgeStatusEmptyHeadings[filters.status]}
        description={content.chatbot.knowledgeStatusEmptyBodies[filters.status]}
        // Nothing is wrong here — the reader asked a question and the answer was
        // "none", which for two of the three statuses is the answer they wanted.
        tone="quiet"
        action={
          <TextLink href={routes.settingsChatbot()}>
            {content.chatbot.knowledgeShowAllSources}
          </TextLink>
        }
      />
    );
  }

  return (
    <EmptyState
      icon="note"
      title={content.chatbot.knowledgeEmptyHeading}
      description={content.chatbot.knowledgeEmptyBody}
      tone={canWrite ? 'neutral' : 'quiet'}
    />
  );
}

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
 * columns and placeholder cells — so the swap to real data shifts nothing.
 *
 * **Row count depends on whether a filter is applied** (TAR-613). Unfiltered,
 * it is the page size the server requests, which is what actually arrives.
 * Filtered, it is three: a narrowed search usually returns one or two entries,
 * and ten skeleton rows collapsing to one is a bigger jolt than a short
 * placeholder growing.
 *
 * `hasActions` stays beside it because this is also the route's `loading.tsx`
 * placeholder, which has no session to read and no filters to read either.
 */
export function KnowledgeDocumentsTableSkeleton({
  hasActions = true,
  isFiltered = false,
}: {
  hasActions?: boolean;
  isFiltered?: boolean;
}) {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.chatbot.knowledgeLoading} />
      <DataTableSkeleton
        caption={content.chatbot.knowledgeHeading}
        rowCount={isFiltered ? KNOWLEDGE_FILTERED_SKELETON_ROWS : KNOWLEDGE_DOCUMENTS_PAGE_SIZE}
        columns={knowledgeColumnMeta(content, hasActions).map((meta) => ({
          ...meta,
          render: () => null,
        }))}
      />
    </>
  );
}
