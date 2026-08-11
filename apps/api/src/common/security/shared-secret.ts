import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compares a secret a caller presented against one this process holds, in
 * constant time.
 *
 * Two places authenticate a peer with a shared secret rather than a session —
 * `PlatformAdminGuard` for the operator surface, and `HostTenantGuard` for the
 * web tier's forwarded host (TAR-148) — and a second, subtly different
 * implementation of a constant-time comparison is the kind of duplication that
 * shows up as a vulnerability rather than as a smell.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak the expected
 * length through the error, so both sides are hashed first and every comparison
 * is 32 bytes against 32 bytes. SHA-256 is a length-equaliser here, not a
 * password hash: these secrets are high-entropy and machine-generated, so there
 * is nothing for a work factor to protect against.
 *
 * The caller is responsible for having a secret at all. An unconfigured secret
 * must fail closed at the call site, never reach this function as an empty
 * string that an empty header would then match.
 */
export function matchesSharedSecret(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
