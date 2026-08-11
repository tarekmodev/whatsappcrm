import { createHash, randomBytes } from 'node:crypto';

/**
 * The credential shape shared by invite links, password-reset links, session
 * cookies and realtime tickets (ADR 0005, "Tokens at rest").
 *
 * 32 bytes from a CSPRNG, handed out as base64url and stored **only** as its
 * SHA-256 hex digest. Two properties follow, and both are the reason this is one
 * file rather than four near-identical helpers:
 *
 *   * A dump of `invites`, `password_reset_tokens` or `sessions` grants nobody
 *     an account: the column holds a digest, and the plaintext exists only in
 *     the email or the cookie.
 *   * SHA-256 rather than argon2id is correct **here specifically**. The input is
 *     256 bits of uniform entropy, so there is no dictionary for a work factor
 *     to slow down — and a memory-hard hash on the session token would tax every
 *     authenticated request in the product for nothing.
 */
const TOKEN_BYTES = 32;

/** The plaintext, which only ever leaves this process inside an email or a cookie. */
export function generateAuthToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** The only form that touches the database. */
export function hashAuthToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
