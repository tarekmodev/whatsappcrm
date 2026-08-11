/**
 * Queue and job names for the outbound send path.
 *
 * String constants rather than an enum, for the reason `queue.constants.ts`
 * gives: they are wire values. A job already in Redis when a deploy lands still
 * names itself with the old string.
 *
 * A queue of its own rather than sharing `webhooks`. The two have opposite
 * shapes — ingest is bursty, fast and driven by Meta's retry timer, while a
 * send is one outbound HTTP call that may be throttled for minutes — and
 * sharing one worker pool would let a rate-limited business account's backlog
 * delay every tenant's inbound messages. Tenant scoping stays in the payload,
 * never in the queue name.
 */
export const CONVERSATIONS_QUEUE = 'conversations';

/** Deliver one `messages` row that is sitting in `queued`, named by id. */
export const SEND_OUTBOUND_MESSAGE_JOB = 'conversation.send-message';

/**
 * How many times one send is attempted before the message is failed.
 *
 * Read by the producer (BullMQ's retry budget) *and* by the handler (which
 * decides on the last attempt to write `failed` rather than throw), so the two
 * cannot drift: a queue that gave up first would leave the message `queued`
 * for ever, and a handler that parked first would make the remaining attempts
 * no-ops.
 *
 * Three, with the backoff below, spans about fourteen seconds. That covers a
 * Meta blip and a short throttle without holding a customer's reply for
 * minutes; a longer outage is what the `failed` status and the agent's retry
 * are for, because a message the customer receives ten minutes late is often
 * worse than one that visibly did not send.
 */
export const SEND_MAX_ATTEMPTS = 3;

/** First retry after 2s, then 4s. Exponential, per BullMQ's own scheme. */
export const SEND_RETRY_BACKOFF_MS = 2_000;

/**
 * Collapses a re-enqueue of the same message into one job.
 *
 * An optimisation, not the correctness mechanism — BullMQ forgets an id once
 * the job leaves the completed set. What prevents a second delivery is the
 * handler's `status = queued` guard, which is a condition on the row.
 *
 * Hyphens, never a colon: BullMQ reserves `:` for its Redis key structure and
 * rejects a custom job id containing one.
 */
export function sendOutboundMessageJobId(messageId: string): string {
  return `send-message-${messageId}`;
}
