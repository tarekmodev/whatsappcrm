import { SkeletonLine } from '@/components/ui/Skeleton';
import { content } from '@/content/en';
import styles from './TicketQueueHeader.module.css';

/**
 * The queue's own bar, above the table. Usage:
 * `<TicketQueueHeader count={tickets.length} hasMore={…} />`.
 *
 * The same two facts the conversation list's header carries (TAR-517), for the
 * same reason: **how many rows are in front of you**, and **what order they are
 * in**. Before this the count was nowhere and the order was a sentence under the
 * card title — "Urgent tickets come first, then the most recently opened." — set
 * as a section description, which is a paragraph doing a control's job.
 *
 * ## The count is the page's, not the tenant's
 *
 * `GET /tickets` answers `take: limit + 1` and no `count(*)`, so the only number
 * this screen honestly has is how many rows it was given. With a page behind it
 * the header says "25+ tickets" rather than pretending to be the whole queue.
 *
 * ## The order is stated, not chosen
 *
 * There is deliberately **no sort control here**, and that is the contract rather
 * than an omission: `GET /tickets` has no `sort` parameter, ADR 0006 §6 declines
 * to add one, and `ticket-query.service.ts` records why — one order, one index,
 * one cursor arity. 0001 says the same thing from the other side ("the ticket
 * queue's order is the API's alone"). A `MenuButton` here would be a control
 * with one entry, which offers a choice that does not exist; re-sorting the page
 * in the browser would be worse, because the page is a *cursor* page and
 * re-ordering 25 of N rows is a queue that lies about what is at the top.
 *
 * So it is a label in the bar where the control would be — the sort explained
 * *at* the queue rather than beside it. The day the endpoint grows a `sort`
 * parameter this is the slot the menu goes in.
 */

export interface TicketQueueHeaderProps {
  /** How many rows the table is about to render. */
  count: number;
  /** There is a page after this one, so the count is a floor rather than a total. */
  hasMore: boolean;
}

export function TicketQueueHeader({ count, hasMore }: TicketQueueHeaderProps) {
  return (
    <div className={styles.header}>
      <p className={styles.count}>
        {hasMore ? content.tickets.queueCountAtLeast(count) : content.tickets.queueCount(count)}
      </p>
      <QueueOrder />
    </div>
  );
}

/**
 * Mirrors the header exactly: the same bar, the same height, a placeholder where
 * the count goes and the **real** order label beside it.
 *
 * Real rather than drawn, for the reason `loading.tsx` keeps the filter bar real:
 * the order is a constant, so it is already known while the rows are in flight,
 * and painting a placeholder over something known would be slower and emptier.
 * Only the count has to wait for the read.
 */
export function TicketQueueHeaderSkeleton() {
  return (
    <div className={styles.header}>
      {/* Sized to the copy it stands in for — "25 tickets" — so the swap moves
          the bar's baseline by nothing. */}
      <SkeletonLine width="5rem" height="var(--font-size-body-sm)" />
      <QueueOrder />
    </div>
  );
}

/** Shared by the header and its skeleton so the two cannot drift apart. */
function QueueOrder() {
  return (
    <p className={styles.order}>
      {content.tickets.queueOrderLabel}{' '}
      <span className={styles.orderValue}>{content.tickets.queueOrder}</span>
    </p>
  );
}
