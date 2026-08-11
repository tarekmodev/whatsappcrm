/**
 * The two ways an `Idempotency-Key` is refused. Typed errors rather than
 * `HttpException`s, for the same reason every other domain error here is: the
 * controller decides the status, the service states the fact.
 */

export abstract class IdempotencyError extends Error {
  protected constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * The key was used before, with a **different** request.
 *
 * `idempotency_key_reused`, 409 — the taxonomy has a code of its own for
 * exactly this, and it is not `conflict`, because the two mean different things
 * to a client: a conflict is retryable with the same key, this one never is.
 * Returning the stored response instead would answer a question the caller did
 * not ask, which for a send means telling them a message went out that did not.
 */
export class IdempotencyKeyReusedError extends IdempotencyError {
  constructor(readonly key: string) {
    super(
      'That Idempotency-Key has already been used for a different request. Generate a new key, ' +
        'or replay the original request unchanged.',
    );
  }
}

/**
 * The key names a request that is **still running** — a client that retried
 * before the first attempt answered.
 *
 * `conflict`, 409, and deliberately not "wait and return the first result":
 * holding this request open would mean two connections and two transaction
 * slots per double-click, and the honest answer is available immediately. The
 * caller retries the same key and gets the stored response once the first
 * attempt finishes, which is the behaviour the header exists to provide.
 */
export class IdempotentRequestInFlightError extends IdempotencyError {
  constructor(readonly key: string) {
    super(
      'A request with that Idempotency-Key is still being processed. Retry with the same key to ' +
        'read its result.',
    );
  }
}
