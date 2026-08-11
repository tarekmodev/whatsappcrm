/**
 * Who holds a conversation, from the reader's point of view.
 *
 * Three states, as a discriminated union rather than an `isMine` boolean —
 * because the boolean had only two answers for a question with three, and the
 * missing one is the dangerous one. "Not mine" collapsed *unclaimed* and *held
 * by a colleague* into a single "Claim" button, so taking a thread off the agent
 * working it looked exactly like picking one out of the shared pool.
 *
 * The server still writes the assignment unconditionally — there is no
 * compare-and-set until TAR-186 closes that — so two people clicking within a
 * second of each other both succeed and both believe they own it. TAR-198 now
 * tells the loser's inbox, which is what stops them replying into a thread that
 * is no longer theirs; it does not stop the write from being blind. The
 * confirmation this union enables is the part that makes the taking deliberate.
 *
 * Derived in one place because the list row and the thread header both ask, and
 * an inbox where the row and the header above it disagree about who owns a
 * conversation is worse than one that says nothing.
 *
 * A thread routed to a *team* with no assignee is `unclaimed`: nobody is holding
 * it, and the claim leaves the team assignment alone.
 */

export type ConversationHold =
  | { readonly state: 'unclaimed' }
  | { readonly state: 'mine' }
  /** Held by somebody else. `holderName` is `null` when the id does not resolve. */
  | { readonly state: 'theirs'; readonly holderName: string | null };

export function conversationHold(
  assignedUserId: string | null,
  currentUserId: string,
  /** The resolved display name for `assignedUserId`, when there is one. */
  assigneeName: string | null,
): ConversationHold {
  if (assignedUserId === null) {
    return { state: 'unclaimed' };
  }

  if (assignedUserId === currentUserId) {
    return { state: 'mine' };
  }

  return { state: 'theirs', holderName: assigneeName };
}
