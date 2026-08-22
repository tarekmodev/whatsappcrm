import type { ReactNode } from 'react';
import type { ContactResponse, ConversationResponse } from '@whatsappcrm/contracts';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Notice } from '@/components/ui/Notice';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { TextLink } from '@/components/ui/TextLink';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import styles from './InboxContextPanel.module.css';

/**
 * Who the open conversation is with, and what it is attached to. Usage:
 * `<InboxContextPanel conversation={conversation} />` in `InboxLayout`'s
 * `context` slot.
 *
 * ## The ticket section
 *
 * The reference this was rebuilt against offers "Create a ticket from this
 * conversation" here. In this product a ticket is not something an agent makes:
 * `TicketLinkerService` puts **every** inbound message on one, opening a ticket
 * for the contact if no active one exists and attaching to it if one does
 * (`docs/architecture/0003-ticket-auto-linking-contract.md`, and the
 * `tickets_one_active_per_contact` invariant behind it). 0002's endpoint table
 * has no `POST /tickets` for exactly that reason.
 *
 * So this section **reports the link rather than offering to make one**: with a
 * `ticketId`, a ticket is open and everything said here is on it; without one,
 * a ticket opens by itself with the customer's next message. A button here would
 * either call an endpoint that does not exist or duplicate work the pipeline
 * already did.
 *
 * Since TAR-286 it also *links* to that ticket, which is where its status and
 * priority are changed. `conversation.ticketId` names the **active** ticket, so
 * resolving one empties this section as well as removing the row from the queue
 * — the panel reporting nothing to link is the correct answer, not a gap.
 *
 * ## The chatbot section
 *
 * Rendered only for a conversation the chatbot has actually been on
 * (`botState !== 'off'`), and passed in as a slot rather than fetched here: it
 * needs a second endpoint, so it gets its own Suspense boundary in
 * `InboxContextSection` and a card that fails on its own. A contact card must
 * never be held up — or taken down — by a summary of what a bot did.
 */
export function InboxContextPanel({
  conversation,
  chatbot,
}: {
  conversation: ConversationResponse;
  /** The chatbot card's contents; omitted for a conversation it never touched. */
  chatbot?: ReactNode;
}) {
  return (
    <Stack gap="4">
      <SectionCard id="contact" title={content.inbox.contextHeading} headingLevel={3}>
        <ContactIdentity contact={conversation.contact} />
      </SectionCard>

      {chatbot === undefined ? null : (
        <SectionCard id="chatbot" title={content.inbox.handoffHeading} headingLevel={3}>
          {chatbot}
        </SectionCard>
      )}

      <SectionCard id="ticket" title={content.inbox.ticketHeading} headingLevel={3}>
        <TicketLink ticketId={conversation.ticketId} />
      </SectionCard>
    </Stack>
  );
}

function ContactIdentity({ contact }: { contact: ContactResponse }) {
  return (
    <Stack gap="3">
      <Cluster gap="3" align="center">
        <Avatar name={contact.displayName} size="md" tone="neutral" />
        <div className={styles.identity}>
          <p className={styles.name}>{contact.displayName}</p>
          {/* `dir="ltr"`: a phone number reads left to right whatever the
              surrounding text direction is. */}
          <p className={styles.detail} dir="ltr">
            {contact.phone}
          </p>
        </div>
      </Cluster>

      {contact.email === null ? null : <p className={styles.detail}>{contact.email}</p>}

      {contact.tags.length === 0 ? null : (
        <Cluster gap="2">
          {contact.tags.map((tag) => (
            <Badge key={tag.id}>{tag.name}</Badge>
          ))}
        </Cluster>
      )}
    </Stack>
  );
}

function TicketLink({ ticketId }: { ticketId: string | null }) {
  if (ticketId === null) {
    return (
      <Stack gap="2">
        <p className={styles.name}>{content.inbox.ticketUnlinked}</p>
        <p className={styles.detail}>{content.inbox.ticketUnlinkedBody}</p>
      </Stack>
    );
  }

  return (
    <Stack gap="2">
      <Notice tone="info">{content.inbox.ticketLinked}</Notice>
      <p className={styles.detail}>{content.inbox.ticketLinkedBody}</p>
      <TextLink href={routes.ticket(ticketId)}>{content.inbox.ticketOpen}</TextLink>
    </Stack>
  );
}

/**
 * Mirrors `InboxContextPanel`: the same two cards, the same avatar-beside-two-
 * lines identity and the same two-line ticket block — so the swap to a real
 * conversation moves nothing.
 */
export function InboxContextPanelSkeleton() {
  return (
    <Stack gap="4">
      <SectionCard id="contact" title={content.inbox.contextHeading} headingLevel={3}>
        <Stack gap="3" aria-hidden="true">
          <Cluster gap="3" align="center">
            <SkeletonLine width="var(--size-control-md)" height="var(--size-control-md)" />
            <div className={styles.identity}>
              <SkeletonLine width="9rem" />
              <SkeletonLine width="7rem" />
            </div>
          </Cluster>
        </Stack>
      </SectionCard>

      <SectionCard id="ticket" title={content.inbox.ticketHeading} headingLevel={3}>
        <div aria-hidden="true">
          <SkeletonText lines={2} />
        </div>
      </SectionCard>
    </Stack>
  );
}
