import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { content } from '@/content/en';
import type { TicketHistoryEntry } from '@/features/tickets/ticket-history';
import styles from './TicketHistoryList.module.css';

/**
 * The ticket's audit trail. Usage:
 * `<TicketHistoryList entries={…} hasMore={…} />`, inside `TicketHistorySection`.
 *
 * A server component: nothing here is interactive, so none of it needs to ship
 * as JavaScript. `RelativeTime` is the one client island inside it, and it is
 * already one for the hydration reason it documents.
 *
 * The list renders from data through a single item component, so a new event
 * type is a row in `ticket-history.ts` rather than another branch in this file.
 */
export function TicketHistoryList({
  entries,
  hasMore,
}: {
  entries: readonly TicketHistoryEntry[];
  /** True when the API had more than one page; says so rather than a count. */
  hasMore: boolean;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState
        icon="ticket"
        title={content.tickets.historyEmptyHeading}
        description={content.tickets.historyEmptyBody}
      />
    );
  }

  return (
    <>
      {/*
        An ordered list, because the order is the meaning: this is a trail read
        newest-first, and a screen reader announcing "list, 5 items" without the
        numbering would lose that.
      */}
      <ol className={styles.list}>
        {entries.map((entry) => (
          <TicketHistoryItem key={entry.id} entry={entry} />
        ))}
      </ol>
      {hasMore ? <p className={styles.more}>{content.tickets.historyMore}</p> : null}
    </>
  );
}

/**
 * One entry. Every line below the title is conditional, and each is absent
 * rather than blank when there is nothing to say — an empty quotation block
 * under half the rows would read as missing data.
 */
function TicketHistoryItem({ entry }: { entry: TicketHistoryEntry }) {
  return (
    <li className={styles.entry}>
      <div className={styles.header}>
        {/* The tone is decoration; this label carries the meaning in words. */}
        <Badge tone={entry.tone}>{entry.title}</Badge>
        {entry.detail === null ? null : <span className={styles.detail}>{entry.detail}</span>}
        <span className={styles.timestamp}>
          <RelativeTime isoTimestamp={entry.createdAt} label={content.tickets.openedAt} />
        </span>
      </div>

      {entry.reason === null ? null : (
        <blockquote className={styles.reason}>
          <span className={styles.reasonLabel}>{content.tickets.historyReason}</span>
          {entry.reason}
        </blockquote>
      )}

      <p className={styles.actor}>{entry.actorLabel}</p>
    </li>
  );
}
