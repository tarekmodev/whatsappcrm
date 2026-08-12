'use client';

import type { ConversationResponse } from '@whatsappcrm/contracts';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { useContent } from '@/lib/content';
import { CONVERSATIONS_PAGE_SIZE } from '@/features/people/constants';
import {
  ConversationRow,
  ConversationRowSkeleton,
  type ClaimContext,
  type InboxListQuery,
} from './ConversationRow';
import styles from './ConversationList.module.css';

/**
 * The conversation list. Usage:
 * `<ConversationList conversations={…} userNames={…} teamNames={…} query={…} selectedId={…} />`.
 *
 * A list of links: every row opens its thread into the pane beside it, and the
 * URL is what says which one is open — so a refresh, a copied link and the back
 * button all reproduce the same view.
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
}

export function ConversationList({
  conversations,
  userNames,
  teamNames,
  query,
  selectedId,
  claim,
}: ConversationListProps) {
  const content = useContent();

  if (conversations.length === 0) {
    // A search that matched nothing is a different answer from a filter with
    // nothing in it, and telling somebody "conversations appear here" when they
    // just searched for a phone number reads as a broken search.
    if (query.q !== undefined) {
      return <EmptyState heading={content.search.emptyHeading} body={content.search.emptyBody} />;
    }

    return (
      <EmptyState
        heading={content.inbox.emptyHeading}
        body={query.scope === 'assigned' ? content.inbox.emptyBody : content.inbox.emptyAllBody}
      />
    );
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
