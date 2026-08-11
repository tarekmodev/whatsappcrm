import {
  InvitePreviewResponseSchema,
  SessionResponseSchema,
  type InviteAcceptInput,
  type InviteLookupInput,
  type InvitePreviewResponse,
  type LoginInput,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { toApiRequestError } from '@/lib/api/error';
import type { ApiRequest } from '@/lib/api/request';

/**
 * The three calls that have to be made **by the browser**, and the small
 * transport that makes them.
 *
 * Everything else in `lib/api` goes through `http.ts` on the server. These three
 * cannot, and the reason is the same for all of them: sign-in and invite
 * acceptance answer with `Set-Cookie`, and a cookie set on a fetch made by the
 * Next process belongs to the Next process, not to the person signing in. Sending
 * them from the browser — to the same-origin `/api` path `next.config.mjs`
 * rewrites to the API host — is what makes the session cookie first-party under a
 * white-label domain (TAR-39, Decision 3).
 *
 * The invite lookup has no cookie of its own, but it is on the same screen as the
 * accept and reads a token that only the browser can see, so it lives here too.
 *
 * No token is read, stored or forwarded by any of this: the browser holds the
 * cookie and sends it back on its own, which is the whole of the console's
 * session handling.
 *
 * Deliberately free of `server-only` and of the fixture transport, so it can be
 * imported from a client component. That also means the mock API mode does not
 * cover these three — it pairs with the role stub, which bypasses the session
 * entirely, so nothing in that mode ever reaches a sign-in screen.
 */

const AUTH_PATH = '/v1/auth';
const INVITES_PATH = '/v1/invites';

export async function login(input: LoginInput): Promise<SessionPrincipal> {
  const response = await browserRequest({
    method: 'POST',
    path: `${AUTH_PATH}/login`,
    body: input,
  });

  return SessionResponseSchema.parse(response).user;
}

/**
 * `POST /api/v1/invites/lookup` — what the accept screen renders before the
 * invitee types anything. Rejects with `token_invalid` (410) for a token that is
 * unknown, expired, already accepted or withdrawn; the four are one answer by
 * design, so this cannot become a tenant-enumeration oracle.
 */
export async function lookupInvite(input: InviteLookupInput): Promise<InvitePreviewResponse> {
  const response = await browserRequest({
    method: 'POST',
    path: `${INVITES_PATH}/lookup`,
    body: input,
  });

  return InvitePreviewResponseSchema.parse(response);
}

/**
 * `POST /api/v1/invites/accept` — set a password, get an account and a session.
 *
 * The body carries a token, a display name and a password. It carries no tenant
 * and no role, and could not: the tenant comes from the request host and the role
 * from the invitation the admin wrote.
 */
export async function acceptInvite(input: InviteAcceptInput): Promise<SessionPrincipal> {
  const response = await browserRequest({
    method: 'POST',
    path: `${INVITES_PATH}/accept`,
    body: input,
  });

  return SessionResponseSchema.parse(response).user;
}

async function browserRequest(request: ApiRequest): Promise<unknown> {
  if (typeof window === 'undefined') {
    // A server-side call here would set the cookie on the wrong machine, and the
    // failure would look like "sign-in silently does nothing". Fail loudly.
    throw new Error('This request must be made by the browser; use apiRequest on the server.');
  }

  const response = await fetch(`${webEnv.apiBaseUrl}${request.path}`, {
    method: request.method,
    // Same-origin already, but explicit: the response's `Set-Cookie` is the
    // entire point of these calls.
    credentials: 'include',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.body),
  });

  if (!response.ok) {
    throw await toApiRequestError(response);
  }

  return (await response.json()) as unknown;
}
