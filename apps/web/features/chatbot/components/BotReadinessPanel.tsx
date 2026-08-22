import type { AiReadiness } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { Cluster } from '@/components/layout/Cluster';
import { content } from '@/content/en';
import styles from './BotReadinessPanel.module.css';

/**
 * Whether the chatbot is answering customers, and — when it is not — every
 * reason it is not. Usage: `<BotReadinessPanel readiness={config.readiness} />`,
 * at the top of the chatbot settings page.
 *
 * This is TAR-28's third acceptance criterion made visible. ADR 0010 decision 4
 * makes the empty-knowledge-base rule structural: with nothing indexed, no
 * prompt is assembled and no request is made, so the chatbot cannot invent an
 * answer. What that buys in the product is silence — and silence is
 * indistinguishable from a broken feature unless the console says which it is.
 *
 * Every failing clause is listed rather than the first, because an admin who
 * clears one of four and still gets silence has learned nothing. The blockers
 * arrive from the API in the order ADR 0010 declares them, and are rendered in
 * that order rather than re-sorted: it runs platform → plan → switch →
 * knowledge base, which is cheapest-to-check first and also, usefully,
 * least-in-the-tenant's-control first.
 */
export function BotReadinessPanel({ readiness }: { readiness: AiReadiness }) {
  if (readiness.ready) {
    return (
      <Stack gap="2">
        <Cluster gap="3" align="center">
          <Badge tone="success">{content.chatbot.readinessOn}</Badge>
          <p className={styles.heading}>{content.chatbot.readyHeading}</p>
        </Cluster>
        <p className={styles.body}>{content.chatbot.readyBody(readiness.indexedDocumentCount)}</p>
      </Stack>
    );
  }

  return (
    <Stack gap="3">
      <Cluster gap="3" align="center">
        {/* `warning`, not `danger`: a chatbot that is not answering is the
            product's normal state and its safe one — a human answers, exactly as
            they did before the feature existed. */}
        <Badge tone="warning">{content.chatbot.readinessOff}</Badge>
        <p className={styles.heading}>{content.chatbot.notReadyHeading}</p>
      </Cluster>
      <p className={styles.body}>{content.chatbot.notReadyBody}</p>
      <ul className={styles.blockers}>
        {readiness.blockers.map((blocker) => (
          <li key={blocker} className={styles.blocker}>
            {content.chatbot.blockers[blocker]}
          </li>
        ))}
      </ul>
    </Stack>
  );
}

/**
 * Mirrors the panel: the same badge-beside-heading row and the same two lines of
 * body text, so the swap to a real answer moves nothing.
 *
 * No blocker list is drawn. Whether there are any — and how many — is exactly
 * what has not arrived, and reserving space for three bullets would leave a gap
 * on the ready path where there is nothing to say.
 *
 * Changed in the same commit as the panel it stands in for.
 */
export function BotReadinessPanelSkeleton() {
  return (
    <Stack gap="2" aria-hidden="true">
      <Cluster gap="3" align="center">
        <SkeletonLine width="3rem" height="1.25rem" />
        <SkeletonLine width="12rem" height="var(--font-size-body-lg)" />
      </Cluster>
      <SkeletonText lines={2} />
    </Stack>
  );
}
