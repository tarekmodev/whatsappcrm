/**
 * Reads the invitation token out of the URL fragment.
 *
 * The emailed link is `https://{tenantHost}/invite#token={token}` (ADR 0005).
 * The fragment is what keeps a live credential out of every access log, proxy log
 * and `Referer` header between the browser and the handler — browsers never send
 * it to a server at all. The cost is that this page must be client-rendered,
 * because the server never sees the token; the benefit is that the token exists
 * only in the address bar until this function hands it to a `POST` body.
 */
export function readInviteToken(hash: string): string | null {
  const token = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('token');

  return token === null || token.length === 0 ? null : token;
}
