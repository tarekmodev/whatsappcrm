import type { ReactNode } from 'react';
import type { ConversationResponse, TicketResponse } from '@whatsappcrm/contracts';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { TextLink } from '@/components/ui/TextLink';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { assigneeLabelFor } from '@/features/tickets/presentation';
import { SlaIndicator } from '@/features/sla/components/SlaIndicator';
import { firstResponseIndicator, resolutionIndicator } from '@/features/sla/presentation';
import { TicketPriorityBadge, TicketStatusBadge } from './TicketBadges';
import styles from './TicketSummary.module.css';

/**
 * What a ticket is and where it stands. Usage:
 * `<TicketSummary ticket={ticket} conversation={conversation} userNames={…} teamNames={…} />`.
 *
 * A description list rather than a grid of divs, so a screen reader reads each
 * value with the term it belongs to. Absent timestamps are omitted rather than
 * rendered as an em dash: a ticket that was closed without being resolved has a
 * null `resolvedAt` deliberately (ADR 0006 §3), and a row saying "Resolved: —"
 * would read as missing data rather than as the fact it is.
 */

export interface TicketSummaryProps {
  ticket: TicketResponse;
  /** `null` when there is none, or when the reader may not open it. */
  conversation: ConversationResponse | null;
  userNames: ReadonlyMap<string, string>;
  teamNames: ReadonlyMap<string, string>;
}

export function TicketSummary({ ticket, conversation, userNames, teamNames }: TicketSummaryProps) {
  const firstResponse = firstResponseIndicator(ticket.sla);
  const resolution = resolutionIndicator(ticket.sla);

  return (
    <Stack gap="4">
      <Cluster gap="2">
        <TicketPriorityBadge priority={ticket.priority} />
        <TicketStatusBadge status={ticket.status} />
        {/* `dir="ltr"`: a reference number reads left to right whatever the
            surrounding text direction is. */}
        <span className={styles.reference} dir="ltr">
          {content.tickets.reference(ticket.number)}
        </span>
      </Cluster>

      <dl className={styles.facts}>
        <Fact term={content.tickets.columnAssignee}>
          {assigneeLabelFor(ticket, userNames, teamNames)}
        </Fact>
        {/* Omitted rather than rendered as "not applicable": a tenant with no
            active SLA policy has no first-response deadline, and a row saying so
            on every ticket is a line of noise on every ticket (TAR-26). */}
        {firstResponse === null ? null : (
          <Fact term={content.sla.firstResponse}>
            <SlaIndicator indicator={firstResponse} />
          </Fact>
        )}
        {resolution === null ? null : (
          <Fact term={content.sla.resolution}>
            <SlaIndicator indicator={resolution} />
          </Fact>
        )}
        <Fact term={content.tickets.openedAt}>
          <RelativeTime isoTimestamp={ticket.createdAt} label={content.tickets.openedAt} />
        </Fact>
        <Fact term={content.tickets.updatedAt}>
          <RelativeTime isoTimestamp={ticket.updatedAt} label={content.tickets.updatedAt} />
        </Fact>
        {ticket.resolvedAt === null ? null : (
          <Fact term={content.tickets.resolvedAt}>
            <RelativeTime isoTimestamp={ticket.resolvedAt} label={content.tickets.resolvedAt} />
          </Fact>
        )}
        {ticket.closedAt === null ? null : (
          <Fact term={content.tickets.closedAt}>
            <RelativeTime isoTimestamp={ticket.closedAt} label={content.tickets.closedAt} />
          </Fact>
        )}
        <Fact term={content.tickets.conversationHeading}>
          <ConversationFact ticket={ticket} conversation={conversation} />
        </Fact>
      </dl>

      {/* The honest signal for "closed unworked", and the shape a cycle-time
          report wants anyway. */}
      {ticket.closedAt !== null && ticket.resolvedAt === null ? (
        <p className={styles.note}>{content.tickets.closedUnresolved}</p>
      ) : null}
    </Stack>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt className={styles.term}>{term}</dt>
      <dd className={styles.value}>{children}</dd>
    </div>
  );
}

function ConversationFact({
  ticket,
  conversation,
}: Pick<TicketSummaryProps, 'ticket' | 'conversation'>) {
  if (conversation !== null) {
    return (
      <TextLink href={routes.inbox({ scope: 'all', conversationId: conversation.id })}>
        {content.tickets.openConversation(conversation.contact.displayName)}
      </TextLink>
    );
  }

  // The id exists and the thread did not come back: ticket visibility and
  // conversation visibility are separate rules, so this is a real state rather
  // than a defensive branch.
  return ticket.conversationId === null
    ? content.tickets.noConversation
    : content.tickets.conversationUnavailable;
}

/**
 * Mirrors `TicketSummary`: the same badge row over the same list of terms, with
 * the terms themselves rendered for real — they are constants, and drawing a
 * placeholder over something already known would be slower and emptier.
 */
export function TicketSummarySkeleton() {
  const terms = [
    content.tickets.columnAssignee,
    content.tickets.openedAt,
    content.tickets.updatedAt,
    content.tickets.conversationHeading,
  ];

  return (
    <Stack gap="4" aria-hidden="true">
      <Cluster gap="2">
        <SkeletonLine width="5rem" height="var(--size-control-sm)" />
        <SkeletonLine width="4rem" height="var(--size-control-sm)" />
        <SkeletonLine width="3rem" />
      </Cluster>
      <dl className={styles.facts}>
        {terms.map((term) => (
          <div key={term} className={styles.fact}>
            <dt className={styles.term}>{term}</dt>
            <dd className={styles.value}>
              <SkeletonLine width="8rem" />
            </dd>
          </div>
        ))}
      </dl>
    </Stack>
  );
}
