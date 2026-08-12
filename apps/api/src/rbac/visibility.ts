import type { Permission, SessionPrincipal } from '@whatsappcrm/contracts';

/**
 * **The** visibility rule for assignable records — conversations (TAR-20),
 * tickets (TAR-21) and anything later that carries an assignee.
 *
 * Written once and imported, never re-typed. It is the single most
 * re-implementable rule in TAR-22, and a second copy that drifts is not a style
 * problem: it is either an agent seeing another team's customer conversations,
 * or a report that aggregates over a wider set than the list endpoint and
 * becomes a read channel around the matrix.
 *
 * ```
 *   holds `<resource>:read_all`   → every record in the tenant
 *   assigned to me                → visible
 *   assigned to a team I am in    → visible
 *   otherwise                     → not visible
 * ```
 *
 * Note what `assigned` means: **mine ∪ my teams'**, not "assigned to me". The
 * name reads narrower than the behaviour, which is why it is stated here. TAR-22
 * AC2 — "conversations routed to a team are visible to its members" — is
 * unsatisfiable otherwise, because an agent has no other route to a team-routed
 * conversation.
 *
 * Tenant scoping is **not** part of this. That is RLS plus the GUC
 * `TenantPrisma` sets, and the two mechanisms are composed rather than
 * alternatives: this decides what a principal sees *inside* their tenant and has
 * no cross-tenant case by construction.
 */

/** The two columns the rule reads. Deliberately structural — no ORM type here. */
export interface AssignableRecord {
  assignedUserId: string | null;
  assignedTeamId: string | null;
}

export function isVisible(
  record: AssignableRecord,
  principal: SessionPrincipal,
  readAll: Permission,
): boolean {
  if (principal.permissions.includes(readAll)) {
    return true;
  }

  if (record.assignedUserId === principal.userId) {
    return true;
  }

  return record.assignedTeamId !== null && principal.teamIds.includes(record.assignedTeamId);
}

/** What a list endpoint was asked for, per `ConversationListQuerySchema`. */
export type RecordScope = 'assigned' | 'unassigned' | 'all';

/**
 * Narrows a requested scope to what the principal may actually have.
 *
 * **Narrow, never reject.** A caller without `_all` asking for `scope=all` gets
 * `assigned`, and no error: a supervisor's shared inbox URL then renders for an
 * agent with less in it rather than 403-ing, and the console shows a notice
 * saying so — that notice is what stops it reading as data loss.
 *
 * `unassigned` needs `_all` here, and this function is the **ticket** rule: an
 * agent cannot browse and self-serve an unclaimed ticket, because that backlog
 * is work somebody has already triaged and widening it would expose the whole
 * tenant's. Tickets reach an agent through assignment (TAR-23/24) or a
 * supervisor.
 *
 * Conversations do not use this — `inboxScopeFilter` is their scope rule and
 * `unassigned` is open there, for the reason `isVisibleOrUnclaimed` states. The
 * `conversation:claim` this comment used to propose shipped in TAR-186; it is
 * bounded to unassigned records by the compare-and-set on the claim route rather
 * than by anything here.
 */
export function narrowScope(
  requested: RecordScope,
  principal: SessionPrincipal,
  readAll: Permission,
): RecordScope {
  return principal.permissions.includes(readAll) ? requested : 'assigned';
}

/**
 * The predicate as a `where` fragment for a list query, or `null` when the
 * principal holds `_all` and the query needs no scope clause at all.
 *
 * `null` rather than an empty object, so a caller that forgets to spread it
 * fails to compile instead of quietly widening a scoped query.
 *
 * ## Why one `OR` rather than a `UNION ALL` of keyset pages
 *
 * TAR-79's open question 1 expected the opposite, and the note asked for a
 * measurement rather than an assumption. `visibility-query-shape.int-spec.ts`
 * is that measurement, against 20 000 conversations in one tenant with the
 * principal holding 800 of them, as `whatsappcrm_app` under RLS:
 *
 * ```
 *   OR form        145 buffers, 0 rows filtered
 *                  Limit / Sort / Bitmap Heap Scan / BitmapOr
 *                    / Bitmap Index Scan using …_assigned_user_inbox_idx
 *                    / Bitmap Index Scan using …_assigned_team_inbox_idx
 *
 *   UNION ALL      187 buffers, 0 rows filtered
 *                  Limit / Merge Append / (Limit / Sort / Bitmap Heap Scan) × 2
 * ```
 *
 * With both of TAR-80's scope indexes present the planner answers the `OR` with
 * a `BitmapOr` across them, so the work already scales with the principal's set
 * rather than the tenant's — the fallback to the tenant-wide index that the note
 * was guarding against does not happen, and the `UNION ALL` is slightly *worse*
 * for the extra append. The simpler shape wins on evidence.
 *
 * The int-spec asserts the property rather than the numbers: both forms must
 * use the scope indexes, and neither may be an order of magnitude worse. If a
 * future planner or a different skew changes that, it fails and says which.
 */
export function visibilityFilter(
  principal: SessionPrincipal,
  readAll: Permission,
): VisibilityFilter | null {
  return principal.permissions.includes(readAll) ? null : assignedFilter(principal);
}

/**
 * "Assigned to me, or to a team I am in" — the same two branches, **without**
 * the `_all` short-circuit.
 *
 * Separated out because the two callers want different things from the same
 * predicate. A *visibility* question is answered `null` for a principal who may
 * see everything, so the query carries no scope clause at all. A list endpoint's
 * explicit `scope=assigned` is a filter the caller chose, and a supervisor
 * asking for their own work must get their own work rather than the tenant's —
 * which is what returning `null` there would give them.
 */
export function assignedFilter(principal: SessionPrincipal): VisibilityFilter {
  return {
    OR: [
      { assignedUserId: principal.userId },
      // `in: []` matches nothing, which is correct for a teamless agent: they
      // see their own work and no team's.
      { assignedTeamId: { in: [...principal.teamIds] } },
    ],
  };
}

/**
 * Structurally a Prisma `where` fragment, but declared here rather than typed
 * against a generated model: the same rule applies to `conversations`,
 * `tickets` and anything later that carries an assignee, and tying it to one of
 * them would make the other two convert.
 */
export interface VisibilityFilter {
  OR: [{ assignedUserId: string }, { assignedTeamId: { in: string[] } }];
}

// ---------------------------------------------------------------------------
// The shared inbox — conversations only (TAR-68)
// ---------------------------------------------------------------------------

/**
 * A record nobody has claimed: no assignee and no team.
 *
 * Written once because it is both a visibility branch and the `unassigned`
 * scope's filter, and the two must mean exactly the same thing — a queue that
 * lists rows the detail route then answers `not_found` for is worse than no
 * queue at all.
 */
export interface UnclaimedFilter {
  assignedUserId: null;
  assignedTeamId: null;
}

/**
 * Built per call rather than shared as one frozen object: these fragments are
 * handed to Prisma as `where` input, which is typed mutable, and a module-level
 * constant reachable from two queries is a shape somebody eventually spreads
 * into and edits.
 */
export function unclaimedFilter(): UnclaimedFilter {
  return { assignedUserId: null, assignedTeamId: null };
}

/**
 * "Nobody is personally on this record" — the compare-and-set a claim writes
 * into its `WHERE` (TAR-186).
 *
 * One column, not two, and the difference from `unclaimedFilter` is the point:
 * a conversation routed to a team is work waiting for one of its members to pick
 * up, so an agent in that team claiming it is the queue working — and the team
 * assignment is left alone, because a thread routed to Billing and answered by
 * one of them is still Billing's. A thread somebody already holds matches
 * nothing here, which is what makes taking one off a colleague impossible
 * through this route whatever it is called with.
 *
 * The other half of "bounded to the caller's teams' unassigned records" (ADR
 * 0004 open item 2) is **not** here: it is the visibility check the claim makes
 * first. A team-routed conversation is invisible to an agent outside that team,
 * so a claim for one answers `not_found` before this predicate is reached.
 */
export function claimableFilter(): ClaimableFilter {
  return { assignedUserId: null };
}

export interface ClaimableFilter {
  assignedUserId: null;
}

/**
 * Nobody holds this record.
 *
 * Two things turn on it, and the second is the one worth stating: an unclaimed
 * conversation is **readable by every agent and writable by none** (TAR-186).
 * Reading it is the shared inbox working as designed; replying to it is two
 * agents answering the same customer, because the shared pool has no owner to
 * make one of them the responder. Claiming is what makes a thread writable, and
 * `ConversationQueryService.requireHeld` is where that is enforced — once, for
 * the send, the note and the status change alike.
 *
 * Note what "held" is and is not: **both** columns null, so a conversation
 * routed to a team counts as held and its members may all write to it. Two of
 * them can therefore still answer the same customer — a narrower failure than
 * the anonymous pool's, since a supervisor or a rule aimed the thread at that
 * team and its members can see each other. Left to TAR-23/24's routing rather
 * than folded in here.
 */
export function isUnclaimed(record: AssignableRecord): boolean {
  return record.assignedUserId === null && record.assignedTeamId === null;
}

/**
 * The visibility rule **for a shared inbox**: `isVisible`, widened by one
 * branch — an unclaimed conversation is visible to every agent in the tenant.
 *
 * ## Why this is a second function rather than a change to `isVisible`
 *
 * `isVisible` is the rule for assignable records generally, and tickets use it.
 * It says unclaimed work is invisible without `_all`, and its own comment argues
 * that widening it "would expose the whole tenant backlog". That argument holds
 * for tickets, where the backlog is a work queue nobody has triaged.
 *
 * It does not hold for conversations, because a conversation is not created by
 * an agent — it is created by a **customer writing in**, and until somebody
 * claims it there is by construction nobody it is visible to. TAR-20's product
 * is a *shared* inbox: a message that arrives and can be seen by no one is not
 * an isolation property, it is an unanswered customer. So the widening is
 * deliberate, bounded to this one entity, and stated here beside the rule it
 * differs from rather than re-derived inside the conversations module.
 *
 * What it does **not** widen: a conversation claimed by somebody else, or
 * routed to a team the principal is not in, stays invisible without
 * `conversation:read_all`. Claiming is the act that takes a thread out of the
 * shared pool — `POST /conversations/{id}/claim` for an agent taking one nobody
 * holds, `POST /conversations/{id}/assign` for a supervisor routing it.
 *
 * ## Visible is not writable
 *
 * This answers a read. It is **not** the check a send, a note or a status change
 * makes: those additionally require that somebody holds the thread, because
 * "every agent may see it" and "every agent may reply to it" are the two halves
 * of the duplicate-reply the shared pool would otherwise invite. See
 * `isUnclaimed` and `ConversationQueryService.requireHeld`.
 */
export function isVisibleOrUnclaimed(
  record: AssignableRecord,
  principal: SessionPrincipal,
  readAll: Permission,
): boolean {
  return isVisible(record, principal, readAll) || isUnclaimed(record);
}

/**
 * A `where` fragment matching everything a principal may see in the shared
 * inbox, or `null` when they hold `_all` and the query needs no scope clause.
 *
 * Three branches rather than `visibilityFilter`'s two, and the third is served
 * by the same `(tenant_id, assigned_user_id, status, last_message_at DESC,
 * id DESC)` index the first one uses — `assigned_user_id IS NULL` is an index
 * condition, and the team column is a cheap heap-side recheck on the rows it
 * returns. The planner answers the whole thing with a `BitmapOr` across TAR-80's
 * two scope indexes, which is the shape `visibility-query-shape.int-spec.ts`
 * measured for the two-branch form.
 */
export function sharedInboxFilter(
  principal: SessionPrincipal,
  readAll: Permission,
): SharedInboxFilter | null {
  const assigned = visibilityFilter(principal, readAll);

  return assigned === null ? null : { OR: [...assigned.OR, unclaimedFilter()] };
}

export interface SharedInboxFilter {
  OR: [{ assignedUserId: string }, { assignedTeamId: { in: string[] } }, UnclaimedFilter];
}
