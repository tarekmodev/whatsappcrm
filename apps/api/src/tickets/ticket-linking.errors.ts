/**
 * The two ways `ensureTicketForMessage` gives up rather than returning a result.
 *
 * The contract draws one line and it is worth restating here: a **skip** is for
 * a state that is correct and will never change on retry — an outbound message,
 * and nothing else. Everything else throws, and the job's retry policy decides
 * what happens next. Both errors below are therefore retryable; neither is
 * something a caller is expected to catch.
 *
 * The other two failures in 0003's error table are raised elsewhere and pass
 * through untouched: `MissingTenantContextError` and `TenantNotActiveError` come
 * out of `TenantPrisma` (`src/prisma/prisma.errors.ts`).
 */

/** Base class, so a processor can recognise "the linker gave up" in one check. */
export abstract class TicketLinkError extends Error {
  protected constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a subclass is down-levelled, which
    // would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * The message named by the trigger is not readable in the tenant in scope.
 *
 * **Retryable, and usually transient.** The realistic causes are commit
 * visibility — the job overtook the transaction that wrote the message — or a
 * sweeper replay running ahead of a rollback. Exhausting the retry budget lands
 * the job in the failed set, which is monitored precisely because a message that
 * never became a ticket is a support request nobody sees.
 *
 * It is also what a forged or stale payload gets: the read runs under RLS, so a
 * `messageId` belonging to another tenant is simply not there.
 */
export class TicketTriggerMessageNotVisibleError extends TicketLinkError {
  constructor(readonly messageId: string) {
    super(
      `Message ${messageId} is not visible in the tenant in scope, so no ticket can be linked to it. ` +
        'Either the write has not committed yet, or this trigger names a message that does not exist.',
    );
  }
}

/**
 * Every attempt both lost the insert race and then found no active ticket to
 * attach to.
 *
 * **Should be unreachable.** One losing insert means a concurrent job won and
 * its ticket is there to attach to on the next attempt; losing repeatedly means
 * something resolved that ticket in between each time, which no realistic
 * traffic pattern produces. If this fires in production it is evidence that the
 * code and `tickets_one_active_per_contact` disagree about what "active" means —
 * 0003 names it as one of the two things to alert on, rather than something to
 * retry forever in silence.
 */
export class TicketLinkRaceUnresolvedError extends TicketLinkError {
  constructor(
    readonly contactId: string,
    readonly attempts: number,
  ) {
    super(
      `Could not create or attach a ticket for contact ${contactId} after ${attempts} attempts: ` +
        'each attempt conflicted with an active ticket that was gone by the time it was read back. ' +
        'Check that tickets_one_active_per_contact still covers exactly the statuses the ' +
        'application treats as active.',
    );
  }
}
