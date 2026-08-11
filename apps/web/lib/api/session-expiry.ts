import { ApiRequestError } from '@/lib/api/http';

/**
 * The one definition of "this caller no longer has a session", so every surface
 * that can hit it — the session bootstrap, every authenticated read, every server
 * action — reaches the same conclusion from the same response.
 *
 * Three API answers mean it (`packages/contracts/src/error-codes.ts`):
 *
 *   - `unauthenticated` — no session, or it expired or was revoked. This is what
 *     an admin deactivating an agent produces on that agent's next request.
 *   - `tenant_mismatch` — the session is being replayed against another tenant's
 *     host. Mapped to 401 by the contract precisely because the right answer is
 *     "sign in again on the host you belong to", not a 403 page.
 *   - any other 401, including a body that failed to parse as the error envelope.
 *     A proxy that answers 401 with HTML is still telling us the same thing.
 *
 * 403 `forbidden` is deliberately **not** here: that caller has a valid session
 * and merely lacks a permission, and bouncing them to sign in would tell them to
 * fix the one thing that is not wrong. They get the explanatory forbidden state
 * that `requirePermission` already renders.
 */
const SESSION_EXPIRED_CODES: ReadonlySet<string> = new Set(['unauthenticated', 'tenant_mismatch']);

const HTTP_UNAUTHORIZED = 401;

export function isSessionExpiredError(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.status === HTTP_UNAUTHORIZED || SESSION_EXPIRED_CODES.has(error.code))
  );
}
