import type { HandoffContextResponse } from '@whatsappcrm/contracts';
import { Badge } from '@/components/ui/Badge';
import { DetailList } from '@/components/ui/DetailList';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { formatConfidence } from '@/features/chatbot/presentation';
import styles from './HandoffPanel.module.css';

/**
 * What the chatbot did before a human took over. Usage:
 * `<HandoffPanel handoff={handoff} />` in the inbox context column.
 *
 * TAR-28's second acceptance criterion asks for the human agent to get "full
 * context", and ADR 0010 decision 6 splits that in two. **The exchange itself is
 * already in the thread** — a bot reply is an ordinary message row, because it
 * was genuinely sent to the customer over WhatsApp — so this panel deliberately
 * does not re-render it. Repeating a transcript beside the transcript would
 * invite the two to disagree, and the one that is wrong would be this one.
 *
 * What it adds is what the thread cannot carry: why the chatbot stopped, how
 * sure it was, and which knowledge base entries it answered from.
 *
 * `citedDocuments` is the field that earns its place. It is what lets an agent
 * see that the chatbot answered from the *refunds* policy when the customer was
 * asking about *shipping* — the most common shape of a confident wrong answer,
 * and invisible from the transcript alone.
 */
export function HandoffPanel({ handoff }: { handoff: HandoffContextResponse }) {
  return (
    <Stack gap="3">
      <DetailList
        items={[
          {
            id: 'reason',
            term: content.inbox.handoffReasonLabel,
            value: content.inbox.handoffReasons[handoff.reason],
          },
          {
            id: 'handed-off-at',
            term: content.inbox.handoffAtLabel,
            value: (
              <RelativeTime
                isoTimestamp={handoff.handedOffAt}
                label={content.inbox.handoffAtLabel}
              />
            ),
          },
          {
            id: 'replies',
            term: content.inbox.handoffRepliesLabel,
            value: content.inbox.handoffReplyCount(handoff.botReplyCount),
          },
          {
            id: 'confidence',
            term: content.inbox.handoffConfidenceLabel,
            value: <Confidence confidence={handoff.confidence} />,
          },
        ]}
      />

      {handoff.triggerMessageBody === null ? null : (
        <Stack gap="1">
          <p className={styles.term}>{content.inbox.handoffTriggerLabel}</p>
          <blockquote className={styles.trigger}>{handoff.triggerMessageBody}</blockquote>
        </Stack>
      )}

      <Stack gap="2">
        <p className={styles.term}>{content.inbox.handoffCitedLabel}</p>
        {handoff.citedDocuments.length === 0 ? (
          <p className={styles.detail}>{content.inbox.handoffCitedNone}</p>
        ) : (
          <Cluster gap="2">
            {handoff.citedDocuments.map((document) => (
              <Badge key={document.id}>{document.title}</Badge>
            ))}
          </Cluster>
        )}
      </Stack>

      <p className={styles.detail}>{content.inbox.handoffExchangeLabel}</p>
    </Stack>
  );
}

/**
 * The composite score and the two halves it is the lower of.
 *
 * Both halves are shown because the composite is a `min`: "0.3 sure" says
 * nothing about *why*, and the answer — thin retrieval, or a model that hedged —
 * is the difference between "add a knowledge base entry" and "lower the
 * threshold". `null` is its own sentence rather than a dash, because the reason
 * is real: on a keyword handoff or a no-match, the model was never called at
 * all.
 */
function Confidence({ confidence }: { confidence: HandoffContextResponse['confidence'] }) {
  if (confidence === null) {
    return <span className={styles.detail}>{content.inbox.handoffConfidenceNone}</span>;
  }

  return (
    <span>
      {content.inbox.handoffConfidenceValue(formatConfidence(content.locale, confidence.score))}
      <span className={styles.breakdown}>
        {content.inbox.handoffConfidenceBreakdown(
          formatConfidence(content.locale, confidence.modelConfidence),
          formatConfidence(content.locale, confidence.retrievalScore),
        )}
      </span>
    </span>
  );
}

/**
 * Mirrors the panel: the same four detail rows, the same quoted trigger and the
 * same cited-entry row, so the swap to a real summary moves nothing.
 *
 * Changed in the same commit as the panel it stands in for.
 */
export function HandoffPanelSkeleton() {
  return (
    <Stack gap="3" aria-hidden="true">
      <SkeletonText lines={4} />
      <SkeletonLine width="8rem" />
      <SkeletonLine width="100%" height="var(--space-6)" />
      <Cluster gap="2">
        <SkeletonLine width="7rem" height="1.25rem" />
      </Cluster>
    </Stack>
  );
}
