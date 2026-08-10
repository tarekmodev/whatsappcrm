import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The two secret comparisons on the WhatsApp webhook route, kept together and
 * free of any framework so they can be tested for exactly what they promise.
 *
 * Both are constant-time. An unauthenticated caller can time this route as often
 * as it likes, and a byte-at-a-time comparison of a 32-byte HMAC is a genuinely
 * practical forgery oracle — not a theoretical one.
 */

/** Meta sends the digest hex-encoded behind this marker. */
const SIGNATURE_PREFIX = 'sha256=';

/**
 * True when `header` is Meta's HMAC-SHA256 of `rawBody` under `appSecret`.
 *
 * **`rawBody` must be the bytes Meta sent.** A body that was parsed to JSON and
 * re-stringified will not match — key order, whitespace and unicode escaping all
 * differ — and the failure looks like a wrong secret rather than what it is,
 * which is why `NestFactory.create(…, { rawBody: true })` is part of this
 * design and not an implementation detail (TAR-39, signature check).
 */
export function isValidWhatsAppSignature(
  rawBody: Buffer | undefined,
  header: unknown,
  appSecret: string,
): boolean {
  if (rawBody === undefined || typeof header !== 'string' || !header.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(header.slice(SIGNATURE_PREFIX.length), 'hex');

  // `Buffer.from(…, 'hex')` stops at the first character outside the alphabet
  // rather than failing, so a malformed header decodes short. `timingSafeEqual`
  // throws on a length mismatch, hence the check — it leaks only the length of a
  // value the caller already chose.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * True when the `hub.verify_token` Meta echoed during the handshake matches the
 * configured one.
 *
 * Compared as SHA-256 digests rather than raw bytes so the comparison is
 * constant-time over inputs of *different* lengths too: `timingSafeEqual` throws
 * on unequal lengths, and a length check placed before it would tell an attacker
 * how long the token is.
 */
export function matchesVerifyToken(candidate: string, expected: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
