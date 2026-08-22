'use client';

import type { ConversationResponse } from '@whatsappcrm/contracts';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { TextLink } from '@/components/ui/TextLink';
import { useContent } from '@/lib/content';
import { routes } from '@/lib/routes';
import { CONVERSATIONS_PAGE_SIZE } from '@/features/people/constants';
import { activeInboxFilterId, INBOX_FILTERS } from '@/features/inbox/inbox-filters';
import {
  ConversationRow,
  ConversationRowSkeleton,
  type ClaimContext,
  type InboxListQuery,
} from './ConversationRow';
import styles from './ConversationList.module.css';

/**
 * The conversation list. Usage:
 * `<ConversationList conversations={…} userNames={…} teamNames={…} query={…} selectedId={…} claim={…} canManageChannels={…} />`.
 *
 * A list of links: every row opens its thread into the pane beside it, and the
 * URL is what says which one is open — so a refresh, a copied link and the back
 * button all reproduce the same view.
 *
 * Empty is three states rather than one — see `ConversationListEmpty` below.
 */

export interface ConversationListProps {
  conversations: readonly ConversationResponse[];
  userNames: ReadonlyMap<string, string>;
  teamNames: ReadonlyMap<string, string>;
  query: InboxListQuery;
  /** The open thread, or `null` for the list-only view. */
  selectedId: string | null;
  /**
   * Who is looking, and which directions of a hold change they may make —
   * `null` for a principal who gets no claim control at all. TAR-71's scope puts
   * the claim on the list as well as the thread, so picking work out of the
   * shared pool does not cost one thread-open per conversation.
   */
  claim: ClaimContext | null;
  /**
   * `channel:manage`. The never-had-any state's action is "connect a number",
   * which only an admin can do — offering it to an agent would be a button that
   * lands them on a settings page their role is refused.
   */
  canManageChannels: boolean;
}

export function ConversationList({
  conversations,
  userNames,
  teamNames,
  query,
  selectedId,
  claim,
  canManageChannels,
}: ConversationListProps) {
  if (conversations.length === 0) {
    return <ConversationListEmpty query={query} canManageChannels={canManageChannels} />;
  }

  return (
    <ul className={styles.list}>
      {conversations.map((conversation) => (
        <ConversationRow
          key={conversation.id}
          conversation={conversation}
          assigneeName={
            conversation.assignedUserId === null
              ? null
              : (userNames.get(conversation.assignedUserId) ?? null)
          }
          teamName={
            conversation.assignedTeamId === null
              ? null
              : (teamNames.get(conversation.assignedTeamId) ?? null)
          }
          isSelected={conversation.id === selectedId}
          query={query}
          claim={claim}
        />
      ))}
    </ul>
  );
}

/**
 * The three answers an empty list can be giving, which used to be one string.
 *
 * - A **search** matched nothing. It quotes the term back and offers to clear
 *   it, because telling somebody "conversations appear here" a second after they
 *   typed a phone number reads as a broken search.
 * - A **filter** is empty. It names the filter and offers the widest view that
 *   is still the day's work, rather than sending them to the whole archive.
 * - There are **no conversations at all** — the unfiltered "All conversations"
 *   view is empty, which is the only view that can say so honestly. That is the
 *   first screen of a new workspace, and its next step is connecting a number.
 */
function ConversationListEmpty({
  query,
  canManageChannels,
}: {
  query: InboxListQuery;
  canManageChannels: boolean;
}) {
  const content = useContent();

  if (query.q !== undefined) {
    return (
      <EmptyState
        icon="search"
        title={content.search.emptyHeading(query.q)}
        description={content.search.emptyBody}
        action={
          <TextLink href={routes.inbox({ scope: query.scope, status: query.status })}>
            {content.search.clear}
          </TextLink>
        }
      />
    );
  }

  const isNarrowed = query.scope !== 'all' || query.status !== undefined;

  if (isNarrowed) {
    const activeFilter = INBOX_FILTERS.find(
      (filter) => filter.id === activeInboxFilterId(query.scope, query.status),
    );

    return (
      <EmptyState
        icon="filter"
        title={
          activeFilter === undefined
            ? content.inbox.filteredEmptyUnnamedHeading
            : content.inbox.filteredEmptyHeading(activeFilter.label)
        }
        description={content.inbox.filteredEmptyBody}
        action={
          <TextLink href={routes.inbox({ scope: 'all', status: 'open' })}>
            {content.inbox.filteredEmptyAction}
          </TextLink>
        }
      />
    );
  }

  return (
    <EmptyState
      icon="conversation"
      title={content.inbox.emptyHeading}
      description={content.inbox.emptyBody}
      action={
        canManageChannels ? (
          <TextLink href={routes.settingsWhatsApp()}>{content.inbox.emptyConnectAction}</TextLink>
        ) : undefined
      }
    />
  );
}

/**
 * Mirrors `ConversationList`: the same scrolling list holding a full page of
 * row skeletons, so the swap to real conversations moves nothing.
 */
export function ConversationListSkeleton({ hasClaim = false }: { hasClaim?: boolean }) {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.inbox.loadingConversations} />
      <ul className={styles.list} aria-hidden="true">
        {Array.from({ length: CONVERSATIONS_PAGE_SIZE }, (_unused, index) => (
          <ConversationRowSkeleton key={index} hasClaim={hasClaim} />
        ))}
      </ul>
    </>
  );
}
