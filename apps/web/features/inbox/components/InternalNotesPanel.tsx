'use client';

import type { InternalNoteResponse } from '@whatsappcrm/contracts';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import { NOTES_SKELETON_COUNT } from '@/features/inbox/constants';
import { InternalNoteForm } from './InternalNoteForm';
import styles from './InternalNotesPanel.module.css';

/**
 * What the team says to each other about a thread. Usage:
 * `<InternalNotesPanel conversationId={…} notes={…} authorNames={…} canWrite={…} isUnclaimed={…} />`.
 *
 * Notes are a **separate entity** from messages, not a message subtype,
 * specifically so no send path can pick one up by accident — the worst possible
 * bug in this product. Nothing in this component or the action behind it can
 * reach a send.
 *
 * That guarantee is invisible to the person typing, so the panel says it: the
 * notice is above the list *and* on the composer's own field, because "the
 * customer never sees this" must not depend on having scrolled up.
 */

export interface InternalNotesPanelProps {
  conversationId: string;
  /** Newest first, as the API returns them. */
  notes: readonly InternalNoteResponse[];
  authorNames: ReadonlyMap<string, string>;
  /** `conversation:note`. Every role holds it today; the panel does not assume so. */
  canWrite: boolean;
  /**
   * Nobody is on this thread. The API refuses a note into the shared pool along
   * with the send (TAR-186) — the note is where two agents would otherwise try
   * to sort out between themselves who is answering, which is the coordination
   * the claim exists to do properly.
   */
  isUnclaimed: boolean;
}

export function InternalNotesPanel({
  conversationId,
  notes,
  authorNames,
  canWrite,
  isUnclaimed,
}: InternalNotesPanelProps) {
  const content = useContent();

  return (
    <Stack gap="3">
      <Notice tone="info">{content.notes.privacyNotice}</Notice>

      {notes.length === 0 ? (
        <EmptyState
          icon="note"
          title={content.notes.emptyHeading}
          description={content.notes.emptyBody}
        />
      ) : (
        <ol className={styles.list}>
          {notes.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              authorName={authorNames.get(note.authorUserId) ?? null}
              authorNames={authorNames}
            />
          ))}
        </ol>
      )}

      {/* Permission first, then the hold — the same order `MessageComposer`
          uses, and the honest one: a role that may not write notes at all is not
          told that claiming would let them. */}
      {!canWrite ? null : isUnclaimed ? (
        <Notice tone="info">{content.inbox.claimBeforeWriting}</Notice>
      ) : (
        <InternalNoteForm conversationId={conversationId} />
      )}
    </Stack>
  );
}

function NoteItem({
  note,
  authorName,
  authorNames,
}: {
  note: InternalNoteResponse;
  authorName: string | null;
  authorNames: ReadonlyMap<string, string>;
}) {
  const content = useContent();
  const mentioned = note.mentionedUserIds
    .map((userId) => authorNames.get(userId))
    .filter((name): name is string => name !== undefined);

  return (
    <li className={styles.note}>
      <Cluster justify="between" align="baseline" gap="2">
        <p className={styles.author}>{authorName ?? content.notes.authorUnknown}</p>
        <RelativeTime isoTimestamp={note.createdAt} label={content.inbox.lastActivity} />
      </Cluster>
      <p className={styles.body}>{note.body}</p>
      {mentioned.length === 0 ? null : (
        <p className={styles.mentions}>{content.notes.mentioned(mentioned.join(', '))}</p>
      )}
    </li>
  );
}

/**
 * Mirrors `InternalNotesPanel`: the same notice, the same list of note cards
 * with an author line, two body lines and the same spacing — so the swap to real
 * notes moves nothing.
 */
export function InternalNotesPanelSkeleton() {
  const content = useContent();

  return (
    <Stack gap="3">
      <LoadingAnnouncement label={content.notes.loading} />
      <Notice tone="info">{content.notes.privacyNotice}</Notice>
      <ol className={styles.list} aria-hidden="true">
        {Array.from({ length: NOTES_SKELETON_COUNT }, (_unused, index) => (
          <li key={index} className={styles.note}>
            <Cluster justify="between" align="baseline" gap="2">
              <SkeletonLine width="8rem" />
              <SkeletonLine width="4rem" />
            </Cluster>
            <SkeletonText lines={2} />
          </li>
        ))}
      </ol>
    </Stack>
  );
}
