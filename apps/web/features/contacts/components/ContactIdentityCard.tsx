import type { ContactResponse } from '@whatsappcrm/contracts';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Cluster } from '@/components/layout/Cluster';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import styles from './ContactIdentityCard.module.css';

/**
 * Who the contact is. Usage: `<ContactIdentityCard contact={contact} />`.
 *
 * Read-only, and that is a contract decision rather than a gap: `phone` is the
 * WhatsApp identity and the tenant-unique dedupe key, so `ContactUpdateInput`
 * omits it and merging two contacts is a separate operation this console does
 * not offer. `displayName` and `email` *are* writable, and editing them is
 * TAR-33's next slice — noted on the issue rather than half-built here.
 *
 * A server component: nothing on it is interactive, so none of it needs to reach
 * the browser.
 */
export function ContactIdentityCard({ contact }: { contact: ContactResponse }) {
  return (
    <SectionCard id="identity" title={content.contacts.identityHeading}>
      <Stack gap="4">
        <Cluster gap="3" align="center">
          <Avatar name={contact.displayName} size="md" tone="neutral" />
          <div className={styles.identity}>
            <p className={styles.name}>{contact.displayName}</p>
            {/* `dir="ltr"`: a phone number reads left to right whatever the
                surrounding text direction is. */}
            <p className={styles.phone} dir="ltr">
              {contact.phone}
            </p>
          </div>
          {contact.optedOutAt === null ? null : (
            <Badge tone="warning">{content.contacts.optedOut}</Badge>
          )}
        </Cluster>

        {contact.optedOutAt === null ? null : (
          <Notice tone="warning">{content.contacts.optedOutHint}</Notice>
        )}

        <DetailList items={detailItems(contact)} />
      </Stack>
    </SectionCard>
  );
}

function detailItems(contact: ContactResponse): DetailListItem[] {
  return [
    {
      id: 'phone',
      term: content.contacts.phoneTerm,
      value: <span dir="ltr">{contact.phone}</span>,
      hint: content.contacts.phoneHint,
    },
    {
      id: 'email',
      term: content.contacts.emailTerm,
      value: contact.email ?? content.contacts.notSet,
    },
    {
      id: 'wa-profile-name',
      term: content.contacts.waProfileNameTerm,
      value: contact.waProfileName ?? content.contacts.notSet,
    },
    {
      id: 'last-contacted',
      term: content.contacts.lastContactedTerm,
      value:
        contact.lastContactedAt === null ? (
          content.contacts.neverContacted
        ) : (
          <RelativeTime
            isoTimestamp={contact.lastContactedAt}
            label={content.contacts.lastContactedTerm}
          />
        ),
    },
    {
      id: 'created',
      term: content.contacts.createdTerm,
      value: <RelativeTime isoTimestamp={contact.createdAt} label={content.contacts.createdTerm} />,
    },
  ];
}
