import type { ReactNode } from 'react';
import type { ContactResponse, ConversationResponse } from '@whatsappcrm/contracts';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
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
  ticket,
}: {
  conversation: ConversationResponse;
  /** The chatbot card's contents; omitted for a conversation it never touched. */
  chatbot?: ReactNode;
  /** The ticket card's contents; omitted for a conversation with no ticket yet. */
  ticket?: ReactNode;
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
        {ticket ?? <NoTicketYet />}
      </SectionCard>
    </Stack>
  );
}

/**
 * The contact, and the fields the panel knows about them.
 *
 * The identity is a face beside two lines; everything under it is a `DetailList`
 * (TAR-518). They were loose paragraphs — an email address with nothing saying
 * it was one, and a row of tags with nothing saying what they were — which is a
 * `<dl>` written without the terms. A screen reader now hears "Email,
 * fatima@…" as one unit instead of a floating string.
 */
function ContactIdentity({ contact }: { contact: ContactResponse }) {
  const items: DetailListItem[] = [
    {
      id: 'phone',
      term: content.inbox.contactPhoneLabel,
      // `dir="ltr"`: a phone number reads left to right whatever the surrounding
      // text direction is.
      value: <span dir="ltr">{contact.phone}</span>,
    },
  ];

  if (contact.email !== null) {
    items.push({ id: 'email', term: content.inbox.contactEmailLabel, value: contact.email });
  }

  if (contact.tags.length > 0) {
    items.push({
      id: 'tags',
      term: content.inbox.contactTagsLabel,
      value: (
        <Cluster gap="2">
          {contact.tags.map((tag) => (
            <Badge key={tag.id}>{tag.name}</Badge>
          ))}
        </Cluster>
      ),
    });
  }

  return (
    <Stack gap="3">
      <Cluster gap="3" align="center">
        <Avatar name={contact.displayName} size="md" tone="neutral" />
        <div className={styles.identity}>
          <p className={styles.name}>{contact.displayName}</p>
        </div>
      </Cluster>

      <DetailList items={items} />
    </Stack>
  );
}

/** A conversation the auto-linker has not put on a ticket yet — see the header. */
function NoTicketYet() {
  return (
    <Stack gap="2">
      <p className={styles.name}>{content.inbox.ticketUnlinked}</p>
      <p className={styles.detail}>{content.inbox.ticketUnlinkedBody}</p>
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
            </div>
          </Cluster>
          {/* The phone row the `DetailList` always has; email and tags are the
              contact's own and are not promised by a placeholder. */}
          <SkeletonLine width="7rem" />
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
