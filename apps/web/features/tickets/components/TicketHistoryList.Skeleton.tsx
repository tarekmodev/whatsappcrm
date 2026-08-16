import { SkeletonLine } from '@/components/ui/Skeleton';
import { TICKET_HISTORY_PAGE_SIZE } from '@/features/tickets/constants';
import styles from './TicketHistoryList.module.css';

/**
 * Mirrors `TicketHistoryList`: the same list, the same per-entry rule and
 * padding, and the same three stacked lines per row — badge-and-title, a
 * movement line, and the byline — so the swap to real entries moves nothing.
 *
 * ## Why three rows and not ten
 *
 * The page size is ten, but a ticket's trail is usually short, and a skeleton
 * that drew ten rows would reserve a screen and a half of height for a panel
 * that then collapses to three entries — a shift downwards, which is the thing
 * the skeleton exists to prevent. Three is the honest floor: the panel grows
 * from it rather than shrinking to it.
 *
 * `TICKET_HISTORY_PAGE_SIZE` is still imported and clamped against, so a future
 * page size *below* three cannot leave this drawing more rows than can arrive.
 */
export function TicketHistoryListSkeleton() {
  return (
    <ol className={styles.list} aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
        <li key={index} className={styles.entry}>
          <div className={styles.header}>
            <SkeletonLine width="8rem" height="var(--size-control-sm)" />
            <SkeletonLine width="10rem" />
          </div>
          <p className={styles.actor}>
            <SkeletonLine width="9rem" />
          </p>
        </li>
      ))}
    </ol>
  );
}

const SKELETON_ROWS = Math.min(3, TICKET_HISTORY_PAGE_SIZE);
