import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Long enough for every correlation id a real client sends — a UUID is 36
 * characters, and the longest trace-context id in common use is 55.
 */
export const REQUEST_ID_MAX_LENGTH = 128;

/**
 * Unreserved URL characters only. Linear to match: one bounded character class,
 * so an adversarial header cannot make this expensive.
 */
const ACCEPTED_REQUEST_ID = new RegExp(`^[A-Za-z0-9._-]{1,${REQUEST_ID_MAX_LENGTH}}$`);

/**
 * The correlation id for one request: the caller's, if it is something we are
 * willing to repeat, and a fresh UUID otherwise.
 *
 * The id is echoed in a response header and copied into every log line, every
 * error envelope and the Sentry tags for the request, so it is caller-controlled
 * input reaching several sinks at once. None of them can be injected through it —
 * pino JSON-encodes its fields and Node rejects control characters in a header
 * value — but an unbounded one is still a caller deciding how much log volume the
 * platform pays for, forever, on every line of a request. The API deliberately
 * does not trust the proxy in front of it (`trust proxy` stays off so `Host` is
 * unforgeable), and this header arrives the same way.
 *
 * A rejected id is replaced rather than trimmed. Truncating would hand back an id
 * that looks like the caller's and correlates with nothing, which is worse for
 * the operator reading it than an obviously unrelated UUID.
 */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  return typeof incoming === 'string' && ACCEPTED_REQUEST_ID.test(incoming)
    ? incoming
    : randomUUID();
}
