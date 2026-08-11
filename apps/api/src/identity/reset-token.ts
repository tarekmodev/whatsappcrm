import { createHash, randomBytes } from 'node:crypto';

/** 256 bits. Not brute-forceable, which is what lets the hash at rest be cheap. */
const TOKEN_BYTES = 32;

export interface IssuedResetToken {
  /** Goes in the email, and nowhere else — never a response body, never a log line. */
  readonly token: string;
  /** The only half that reaches the database. */
  readonly tokenHash: string;
}

/**
 * Mints a password-reset token and the hash to store beside it.
 *
 * `randomBytes` rather than anything seeded from the clock or from `Math.random`:
 * this value is the entire authority to take over an account for the next hour,
 * and a predictable one is a takeover anybody can compute.
 */
export function issueResetToken(): IssuedResetToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');

  return { token, tokenHash: hashResetToken(token) };
}

/**
 * SHA-256 hex, matching `invites` and `sessions` — a database leak yields no
 * usable link.
 *
 * SHA-256 rather than argon2id **here specifically**: the input is 256 bits of
 * uniform entropy from a CSPRNG, not a human-chosen password, so there is no
 * dictionary for a work factor to slow down and a KDF would only tax the lookup
 * (TAR-53, security and access).
 */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
