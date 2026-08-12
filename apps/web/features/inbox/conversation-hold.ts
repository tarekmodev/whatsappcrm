/**
 * Who holds a conversation, from the reader's point of view.
 *
 * Three states, as a discriminated union rather than an `isMine` boolean —
 * because the boolean had only two answers for a question with three, and the
 * missing one is the dangerous one. "Not mine" collapsed *unclaimed* and *held
 * by a colleague* into a single "Claim" button, so taking a thread off the agent
 * working it looked exactly like picking one out of the shared pool.
 *
 * TAR-186 made the two directions different writes as well as different words: a
 * claim is a compare-and-set the server refuses when somebody got there first, a
 * take-over is still the blind assignment — deliberately, because taking a
 * thread off a colleague is exactly the act that must not be refused for being
 * already held. So the confirmation in front of the third state is doing real
 * work, not standing in for a missing check.
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

/**
 * Nobody at all is on this conversation: no assignee **and** no team.
 *
 * A different question from `conversationHold`'s `unclaimed` state, and the
 * difference is a thread routed to a team with no assignee. That one is
 * claimable — the state above says so, and taking it leaves the team alone — but
 * it is not in the anonymous shared pool, because a supervisor or a rule
 * deliberately put it in front of that team.
 *
 * This is the one the API's write rule uses (TAR-186): a send, a note or a
 * status change on a thread with nobody at all on it is refused, so the console
 * shuts those boxes rather than letting an agent type into a 409.
 */
export function isConversationUnclaimed(
  assignedUserId: string | null,
  assignedTeamId: string | null,
): boolean {
  return assignedUserId === null && assignedTeamId === null;
}

/**
 * What the reader may do to this hold — which is two different permissions, not
 * one (TAR-186).
 *
 * Picking a thread out of the shared pool is `conversation:claim` and every role
 * has it. Releasing one, or taking one off the colleague working it, is
 * `conversation:assign` and stays supervisor and above. Derived here because the
 * list row and the thread header both ask, and a list that offers a control the
 * header hides is the same disagreement `conversationHold` exists to prevent.
 *
 * UX only. The API checks the same two permissions on every request, and the
 * claim additionally refuses a thread somebody already holds.
 */
export interface HoldPermissions {
  readonly canClaim: boolean;
  readonly canAssign: boolean;
}

export function canChangeHold(hold: ConversationHold, permissions: HoldPermissions): boolean {
  return hold.state === 'unclaimed' ? permissions.canClaim : permissions.canAssign;
}
