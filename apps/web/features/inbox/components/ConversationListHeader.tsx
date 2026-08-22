'use client';

import Link from 'next/link';
import { CONVERSATION_SORTS } from '@whatsappcrm/contracts';
import { Icon } from '@/components/ui/Icon';
import { MenuButton } from '@/components/ui/MenuButton';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import type { InboxListQuery } from './ConversationRow';
import styles from './ConversationListHeader.module.css';

/**
 * The conversation column's own header. Usage:
 * `<ConversationListHeader count={…} hasMore={…} query={…} conversationId={…} />`.
 *
 * Two things, and they are the two the list could not say for itself: **how many
 * rows are in front of you**, and **what order they are in**. It sticks to the
 * top of the scrolling column so both survive scrolling a full page of rows.
 *
 * ## The count is the page's, not the tenant's
 *
 * The list read is deliberately built without a `count(*)` over a table that is
 * appended to continuously (`conversation-query.service.ts`), so the only number
 * this screen honestly has is how many rows it was given. When there is a page
 * after this one it says "25+" rather than pretending to be the whole queue.
 *
 * ## The sort is a link, not a control with state
 *
 * Each entry is a real `Link` to the same view in the other order, so the order
 * is in the URL: a refresh, a copied link and the back button all reproduce it.
 * The open thread rides along, because re-ordering the column must not close the
 * conversation being read.
 *
 * ## What is not here yet
 *
 * The design puts a select-all checkbox in this bar, with the selection count
 * and bulk actions replacing the sort while a selection is live. 0002's
 * conversation endpoints have no bulk claim, assign or status route — every one
 * of them addresses a single id — so a checkbox here would select rows for
 * actions that cannot be performed. It lands with the endpoints.
 */

export interface ConversationListHeaderProps {
  /** How many rows the list is rendering. */
  count: number;
  /** There is a page after this one, so the count is a floor rather than a total. */
  hasMore: boolean;
  /** The view this header belongs to, including the order it is in. */
  query: InboxListQuery;
  /** The open thread, carried into every sort link so re-ordering keeps it open. */
  conversationId: string | null;
}

export function ConversationListHeader({
  count,
  hasMore,
  query,
  conversationId,
}: ConversationListHeaderProps) {
  const content = useContent();

  return (
    <div className={styles.header}>
      <p className={styles.count}>
        {hasMore
          ? content.inbox.conversationCountAtLeast(count)
          : content.inbox.conversationCount(count)}
      </p>
      <SortMenu query={query} conversationId={conversationId} />
    </div>
  );
}

/**
 * Mirrors `ConversationListHeader`: the same bar, the same height, a placeholder
 * where the count goes and the **real** sort control beside it.
 *
 * Real rather than drawn, for the reason `loading.tsx` keeps the filter column
 * real: the order comes from the URL, so it is already known while the rows are
 * still in flight, and painting a placeholder over something known would be
 * slower and emptier. Only the count has to wait for the read.
 */
export function ConversationListHeaderSkeleton({
  query,
  conversationId,
}: {
  query: InboxListQuery;
  conversationId: string | null;
}) {
  return (
    <div className={styles.header}>
      {/* Sized to the copy it stands in for — "24 conversations" — so the swap
          moves the bar's baseline by nothing. */}
      <SkeletonLine width="7rem" height="var(--font-size-body-sm)" />
      <SortMenu query={query} conversationId={conversationId} />
    </div>
  );
}

/**
 * The order picker, shared by the header and its skeleton so the two cannot
 * drift into different controls.
 */
function SortMenu({
  query,
  conversationId,
}: {
  query: InboxListQuery;
  conversationId: string | null;
}) {
  const content = useContent();

  return (
    <MenuButton
      label={
        <>
          {content.inbox.sorts[query.sort]}
          <Icon name="chevronDown" size="sm" />
        </>
      }
      accessibleName={content.inbox.sortLabel}
      align="end"
      triggerClassName={styles.trigger}
    >
      {({ close }) => (
        <ul className={styles.menuList}>
          {CONVERSATION_SORTS.map((sort) => (
            <li key={sort}>
              <Link
                className={styles.menuItem}
                href={routes.inbox({
                  ...query,
                  sort,
                  ...(conversationId === null ? {} : { conversationId }),
                })}
                // The path does not change — only the query — so `MenuButton`'s
                // own close-on-navigation cannot fire and the panel is told.
                onClick={close}
                aria-current={sort === query.sort ? 'true' : undefined}
                scroll={false}
              >
                {/* Reserved on every entry, so choosing one does not shift the
                    others sideways. */}
                <span
                  className={styles.tick}
                  data-current={sort === query.sort ? 'true' : undefined}
                >
                  <Icon name="check" size="sm" />
                </span>
                {content.inbox.sorts[sort]}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </MenuButton>
  );
}
