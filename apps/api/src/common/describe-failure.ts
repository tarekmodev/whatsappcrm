/** Node attaches a `code` to system-level errors — `ECONNREFUSED` and friends. */
interface ErrorWithCode extends Error {
  code?: unknown;
}

/**
 * A short, safe label for why a dependency probe failed.
 *
 * Two constraints pull against each other. The label is returned to an
 * unauthenticated caller on `/api/health/ready`, so it must never carry a
 * message — those contain host names, ports and occasionally credentials. But
 * `"AggregateError"`, which is what a `pg` or `ioredis` connection failure
 * surfaces as, tells whoever is woken up nothing at all.
 *
 * So: unwrap to the first real cause and report its `code` — `ECONNREFUSED`
 * against `ETIMEDOUT` is the difference between "it is not listening" and "the
 * network is eating packets", which is the first thing an on-call engineer wants
 * to know and gives away nothing.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return describeFailure(error.errors[0]);
  }

  if (error instanceof Error) {
    const { code } = error as ErrorWithCode;

    return typeof code === 'string' && code.length > 0 ? code : error.name;
  }

  return 'unknown error';
}
