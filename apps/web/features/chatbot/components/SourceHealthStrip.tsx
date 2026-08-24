import Link from 'next/link';
import type { KnowledgeDocumentStatus } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import type { SourceHealth } from '../chatbot.data';
import type { KnowledgeListParams } from '../knowledge-params';
import { KNOWLEDGE_STATUS_FILTER_ORDER, KNOWLEDGE_STATUS_TONES } from '../presentation';
import styles from './SourceHealthStrip.module.css';

/**
 * How many sources are ready, indexing and failed — three figures, each a filter
 * link. Usage: `<SourceHealthStrip health={health} filters={filters} />`, above
 * the sources card's filter bar.
 *
 * **The one number an admin comes to this card for is "can the chatbot answer
 * yet".** The table below can say it, but only by being read row by row, and
 * only for the ten rows on this page. The strip answers it for the whole
 * knowledge base in three figures, and makes each of them the way into the rows
 * behind it.
 *
 * **One source of truth for status colour.** The dot reads
 * `KNOWLEDGE_STATUS_TONES`, which is the same map the badge in the row below
 * reads — a second mapping here is how a `Failed` badge ends up amber beside a
 * red tile.
 *
 * **Failed is the only tile that ever fills.** A saturated tile is a claim on
 * somebody's attention, and three of them would be none. `Failed` at zero is a
 * plain sunken tile like the others: nothing has gone wrong, so nothing shouts.
 *
 * Not rendered at all when the tenant has no sources — the caller checks
 * `hasAnySources`, because the table's empty state is the whole story then and a
 * strip of three zeroes above it is furniture.
 */
export function SourceHealthStrip({
  health,
  filters,
}: {
  health: SourceHealth;
  filters: KnowledgeListParams;
}) {
  return (
    // A `nav`, not a list of statistics: every tile goes somewhere, and the
    // `aria-current` convention below is `FilterPills`', not a new one.
    <nav aria-label={content.chatbot.sourceHealthLabel}>
      <ul className={styles.strip}>
        {KNOWLEDGE_STATUS_FILTER_ORDER.map((status) => {
          const { count, isCapped } = counts(health)[status];
          const countText = isCapped
            ? content.chatbot.sourceHealthCountCapped(count)
            : content.chatbot.sourceHealthCount(count);
          const label = content.chatbot.statuses[status];

          return (
            <li key={status}>
              <Link
                // The search term rides along: a status picked while a search is
                // on must narrow that search rather than replace it.
                href={routes.settingsChatbot({ q: filters.q, status })}
                className={styles.tile}
                data-status={status}
                // Saturated only when there is something to act on.
                data-alarming={status === 'failed' && count > 0 ? 'true' : undefined}
                aria-current={filters.status === status ? 'page' : undefined}
                aria-label={content.chatbot.sourceHealthTileName(label, countText)}
                scroll={false}
              >
                {/* Hidden from the accessibility tree because the link's own
                    name already says both, in the order a sighted reader takes
                    them: the figure first, then what it counts. */}
                <span className={styles.count} aria-hidden="true">
                  {countText}
                </span>
                <span className={styles.label} aria-hidden="true">
                  <span className={styles.dot} data-tone={KNOWLEDGE_STATUS_TONES[status]} />
                  {label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function counts(
  health: SourceHealth,
): Record<KnowledgeDocumentStatus, { count: number; isCapped: boolean }> {
  return {
    indexed: { count: health.readyCount, isCapped: false },
    pending: { count: health.indexingCount, isCapped: health.isIndexingCapped },
    failed: { count: health.failedCount, isCapped: health.isFailedCapped },
  };
}

/**
 * The strip's stand-in. Real labels with a placeholder where each figure goes,
 * rather than three blank boxes: the labels are known before the counts are, and
 * drawing them keeps the strip exactly as tall — and as legible — while the read
 * is in flight.
 */
export function SourceHealthStripSkeleton() {
  return (
    <div className={styles.strip} aria-hidden="true">
      {KNOWLEDGE_STATUS_FILTER_ORDER.map((status) => (
        <div key={status} className={styles.tile}>
          <span className={styles.countPlaceholder} />
          <span className={styles.label}>
            <span className={styles.dot} data-tone={KNOWLEDGE_STATUS_TONES[status]} />
            {content.chatbot.statuses[status]}
          </span>
        </div>
      ))}
    </div>
  );
}
