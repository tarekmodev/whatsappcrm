import { Notice } from '@/components/ui/Notice';
import { content } from '@/content/en';
import { verifySession } from '@/lib/session/session';
import { loadInbox, type InboxQuery } from '@/features/inbox/inbox.data';
import { ConversationList, ConversationListSkeleton } from './ConversationList';
import styles from './InboxSection.module.css';

/**
 * Fetches and renders the conversation list. Usage: inside a Suspense boundary
 * on the inbox page, with `InboxSectionSkeleton` as the fallback.
 *
 * No card and no heading: since TAR-513 the list is a column of the workspace
 * rather than a section of a document, and `InboxLayout` owns the column's
 * frame, its scrolling and its accessible name. Since TAR-517 it owns no padding
 * either — the rows run to the column's edges and pad themselves, which is what
 * lets the hairline between two of them be a hairline rather than a gap.
 */

export interface InboxSectionProps {
  query: InboxQuery;
  /** The open thread, so the list can mark it. `null` for the list-only view. */
  selectedId: string | null;
  /** True when the API answers `all` with less than the whole tenant. */
  isScopeNarrowed: boolean;
}

export async function InboxSection({ query, selectedId, isScopeNarrowed }: InboxSectionProps) {
  const [session, { conversations, hasMore, userNames, teamNames }] = await Promise.all([
    verifySession(),
    loadInbox(query),
  ]);
  // Request-cached, so this costs no extra round trip on top of the page's own
  // session check. Two permissions rather than one since TAR-186: every role may
  // claim what nobody holds, only a supervisor may release it or take it off a
  // colleague.
  const canClaim = session.checker.can('conversation:claim');
  const canAssign = session.checker.can('conversation:assign');
  const claim =
    canClaim || canAssign ? { currentUserId: session.principal.userId, canClaim, canAssign } : null;

  return (
    <div className={styles.column}>
      {isScopeNarrowed ? (
        // The API narrows `all` rather than refusing it; saying so is what
        // stops an agent wondering why a shared supervisor link shows so
        // little. Padded, because it is prose rather than a row.
        <div className={styles.notice}>
          <Notice tone="info">{content.inbox.scopeNarrowedAllNotice}</Notice>
        </div>
      ) : null}
      <ConversationList
        conversations={conversations}
        hasMore={hasMore}
        userNames={userNames}
        teamNames={teamNames}
        query={{ scope: query.scope, status: query.status, q: query.q, sort: query.sort }}
        selectedId={selectedId}
        claim={claim}
        canManageChannels={session.checker.can('channel:manage')}
      />
    </div>
  );
}

/**
 * Mirrors `InboxSection`'s frame, with the list's own skeleton inside it.
 *
 * It takes the view rather than a permission flag: the column's header shows the
 * order while the rows are still in flight, and the row's height no longer
 * depends on who is looking — the claim control left the resting row in TAR-517,
 * so a supervisor's rows and an agent's are the same height and there is nothing
 * left to reserve.
 */
export function InboxSectionSkeleton({
  query,
  selectedId,
}: {
  query: Pick<InboxQuery, 'scope' | 'status' | 'q' | 'sort'>;
  selectedId: string | null;
}) {
  return (
    <div className={styles.column}>
      <ConversationListSkeleton
        query={{ scope: query.scope, status: query.status, q: query.q, sort: query.sort }}
        conversationId={selectedId}
      />
    </div>
  );
}
