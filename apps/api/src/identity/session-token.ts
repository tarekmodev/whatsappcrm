import { createHash, randomBytes } from 'node:crypto';

/**
 * The session credential itself: how it is minted, and the only form of it that
 * ever touches the database.
 *
 * Kept as free functions rather than a service because none of it has state or
 * a dependency, and because the invite and reset flows (TAR-55, TAR-57) need
 * exactly the same two operations — a shared *service* would have made them
 * inject sessions to hash a string.
 */

/**
 * 256 bits from the CSPRNG. Never `Math.random`, and never a counter or a
 * derived value: this string is the entire proof of identity for every request
 * that follows it, so its only defence is being unguessable.
 *
 * base64url so it survives a `Set-Cookie` header untouched — no padding, no
 * characters the cookie grammar reserves, and 43 characters rather than the 64
 * hex would cost on every request.
 */
export const SESSION_TOKEN_BYTES = 32;

export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * SHA-256 hex, which is what `sessions.token_hash` holds. A database dump
 * therefore yields no usable session.
 *
 * SHA-256 rather than argon2id is correct *here specifically*, and the
 * distinction is worth stating because it looks like an inconsistency next to
 * `PasswordService`: the input is 256 bits of uniform entropy, not a
 * human-chosen password, so there is no dictionary for a work factor to slow
 * down — while a KDF on this value would tax every authenticated request in the
 * product rather than only logins.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
