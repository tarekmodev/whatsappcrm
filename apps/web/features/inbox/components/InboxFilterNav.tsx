'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { TextLink } from '@/components/ui/TextLink';
import { useContent } from '@/lib/content';
import { routes, type ConversationStatusFilter, type InboxScope } from '@/lib/routes';
import {
  INBOX_FILTERS,
  INBOX_FILTERS_PRIMARY_COUNT,
  activeInboxFilterId,
  type InboxFilter,
} from '@/features/inbox/inbox-filters';
import styles from './InboxFilterNav.module.css';

/**
 * The inbox's filter column. Usage:
 * `<InboxFilterNav scope={…} status={…} conversationId={…} canManageChannels={…} />`.
 *
 * Every entry is a real link carrying the current thread with it, so switching
 * filter keeps the conversation an agent is reading open — and so the filter is
 * in the URL, shareable and restored by the back button, which is why this
 * replaced the pill strip that used to sit above the list.
 *
 * ## Two shapes, one markup
 *
 * Above the column breakpoint this is a column beside the list, always open.
 * Below it there is no room for a fourth column, so the same list becomes a
 * disclosure under a button naming the current filter — the entries, their
 * links and their current-marking are identical, only the wrapper changes. The
 * disclosure state is client state on purpose: which filter you are on is in
 * the URL, whether the picker is open is not something to share.
 *
 * ## No unread counts
 *
 * The reference puts a count beside every entry, and since TAR-514 the chip that
 * would render one exists — `Badge variant="count"`. What does not exist is the
 * read behind it: `ConversationResponse` carries `unreadCount` per conversation
 * and 0002 exposes no counts-by-filter endpoint, so the only number this column
 * could compute is "unread in the page of the filter you are already on", which
 * is not what a count beside *another* filter means. Seven `count(*)` queries per
 * inbox render is also the cost `conversation-query.service.ts` is explicitly
 * built to avoid, so the endpoint is a decision for 0002 rather than something to
 * add here.
 *
 * The entries therefore leave the slot empty. When the read lands, this renders
 * `<Badge variant="count">` right-aligned per entry, and a zero renders nothing —
 * a column of zeroes reads as a broken screen.
 */

export interface InboxFilterNavProps {
  scope: InboxScope;
  status: ConversationStatusFilter | undefined;
  /** The open thread, carried into every entry so filtering does not close it. */
  conversationId: string | null;
  /** `channel:manage` — the permission behind the settings link at the foot. */
  canManageChannels: boolean;
}

export function InboxFilterNav({
  scope,
  status,
  conversationId,
  canManageChannels,
}: InboxFilterNavProps) {
  const content = useContent();
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const listId = useId();
  const secondaryId = useId();

  const activeId = activeInboxFilterId(scope, status);
  const active = INBOX_FILTERS.find((filter) => filter.id === activeId) ?? null;
  const primary = INBOX_FILTERS.slice(0, INBOX_FILTERS_PRIMARY_COUNT);
  const secondary = INBOX_FILTERS.slice(INBOX_FILTERS_PRIMARY_COUNT);

  function hrefFor(filter: InboxFilter): string {
    return routes.inbox({
      scope: filter.scope,
      status: filter.status,
      conversationId: conversationId ?? undefined,
    });
  }

  return (
    <nav className={styles.column} aria-label={content.inbox.filtersLabel}>
      <div className={styles.header}>
        <p className={styles.heading}>{content.inbox.filtersHeading}</p>
        <button
          type="button"
          className={styles.disclosure}
          aria-expanded={isOpen}
          aria-controls={listId}
          onClick={() => {
            setIsOpen((current) => !current);
          }}
        >
          <span className={styles.disclosureLabel}>
            {active?.label ?? content.inbox.filtersToggle}
          </span>
          <Icon name="chevronDown" size="sm" className={styles.disclosureIcon} />
        </button>
      </div>

      <div id={listId} className={styles.body} data-open={isOpen ? 'true' : 'false'}>
        <FilterList
          filters={primary}
          activeId={activeId}
          hrefFor={hrefFor}
          onNavigate={() => {
            setIsOpen(false);
          }}
        />

        <button
          type="button"
          className={styles.boundary}
          aria-expanded={isExpanded}
          aria-controls={secondaryId}
          onClick={() => {
            setIsExpanded((current) => !current);
          }}
        >
          <Icon name="chevronDown" size="sm" className={styles.boundaryIcon} />
          {isExpanded ? content.nav.showLess : content.nav.showMore}
        </button>

        {/* Dropped rather than hidden: these are links, and a link left in the
            tree behind `hidden` is one CSS mistake from an invisible tab stop. */}
        <div id={secondaryId}>
          {isExpanded ? (
            <FilterList
              filters={secondary}
              activeId={activeId}
              hrefFor={hrefFor}
              onNavigate={() => {
                setIsOpen(false);
              }}
            />
          ) : null}
        </div>

        {/* Pinned to the foot of the column, as the reference does — but only
            the entry that leads somewhere. Compose and Actions in the reference
            start an outbound conversation and bulk-edit a selection; this
            product has neither endpoint, so neither is a button here. */}
        {canManageChannels ? (
          <div className={styles.footer}>
            <TextLink href={routes.settingsWhatsApp()}>
              <Icon name="settings" size="sm" />
              {content.inbox.inboxSettings}
            </TextLink>
          </div>
        ) : null}
      </div>
    </nav>
  );
}

function FilterList({
  filters,
  activeId,
  hrefFor,
  onNavigate,
}: {
  filters: readonly InboxFilter[];
  activeId: string | null;
  hrefFor: (filter: InboxFilter) => string;
  onNavigate: () => void;
}) {
  return (
    <ul className={styles.list}>
      {filters.map((filter) => (
        <li key={filter.id}>
          <Link
            href={hrefFor(filter)}
            className={styles.entry}
            aria-current={filter.id === activeId ? 'page' : undefined}
            scroll={false}
            onClick={onNavigate}
          >
            {filter.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
