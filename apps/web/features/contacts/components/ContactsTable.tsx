import type { ReactNode } from 'react';
import type { ContactResponse } from '@whatsappcrm/contracts';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Cluster } from '@/components/layout/Cluster';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { TextLink } from '@/components/ui/TextLink';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { ContactTagList } from './ContactTagList';
import { contactColumnMeta } from './contact-columns';
import styles from './ContactsTable.module.css';

/**
 * The contact directory. Usage:
 * `<ContactsTable contacts={contacts} isFiltered={isFiltered} />`.
 *
 * A **server** component, unlike the agents table: every row action here is a
 * link rather than a dialog, so nothing about it needs to run in the browser and
 * none of it reaches the client bundle. `RelativeTime` is the one client leaf,
 * and it is a client component in its own right.
 *
 * `isFiltered` picks between the two empty states, because "this workspace has
 * no contacts" and "no contact matches VIP" need different copy and different
 * next actions — offering "clear the filter" to a workspace that has never had a
 * contact would be advice that does nothing.
 */
export function ContactsTable({
  contacts,
  isFiltered,
}: {
  contacts: readonly ContactResponse[];
  isFiltered: boolean;
}) {
  if (contacts.length === 0) {
    return isFiltered ? (
      <EmptyState
        icon="filter"
        title={content.contacts.filteredEmptyHeading}
        description={content.contacts.filteredEmptyBody}
        action={<TextLink href={routes.contacts()}>{content.contacts.clearFilters}</TextLink>}
      />
    ) : (
      <EmptyState
        icon="contact"
        title={content.contacts.emptyHeading}
        description={content.contacts.emptyBody}
      />
    );
  }

  return (
    <DataTable
      caption={content.contacts.listHeading}
      columns={CONTACT_COLUMNS}
      rows={contacts}
      getRowKey={(contact) => contact.id}
    />
  );
}

const RENDERERS: Record<string, (contact: ContactResponse) => ReactNode> = {
  name: (contact) => (
    <Cluster gap="3" align="center">
      <Avatar name={contact.displayName} tone="neutral" />
      <span className={styles.identity}>
        {/* The whole row's affordance is this link: a `<tr>` with a click handler
            is unreachable by keyboard and announces nothing. */}
        <TextLink href={routes.contact(contact.id)} className={styles.name}>
          {contact.displayName}
        </TextLink>
        {contact.optedOutAt === null ? null : (
          <Badge tone="warning">{content.contacts.optedOut}</Badge>
        )}
      </span>
    </Cluster>
  ),
  // `dir="ltr"`: a phone number reads left to right whatever the surrounding
  // text direction is.
  phone: (contact) => (
    <span className={styles.phone} dir="ltr">
      {contact.phone}
    </span>
  ),
  email: (contact) =>
    contact.email === null ? (
      <span className={styles.muted}>{content.contacts.noEmail}</span>
    ) : (
      contact.email
    ),
  tags: (contact) => <ContactTagList tags={contact.tags} />,
  lastContacted: (contact) =>
    contact.lastContactedAt === null ? (
      <span className={styles.muted}>{content.contacts.neverContacted}</span>
    ) : (
      <RelativeTime
        isoTimestamp={contact.lastContactedAt}
        label={content.contacts.columnLastContacted}
      />
    ),
};

/**
 * Built once at module scope rather than per render: the renderers close over
 * nothing but their row, so rebuilding the array on every request would be work
 * with no output.
 */
const CONTACT_COLUMNS: DataTableColumn<ContactResponse>[] = contactColumnMeta(content).map(
  (meta) => ({ ...meta, render: RENDERERS[meta.key] ?? (() => null) }),
);
