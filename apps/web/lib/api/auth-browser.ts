import {
  InvitePreviewResponseSchema,
  RealtimeTicketResponseSchema,
  SessionResponseSchema,
  SignupAcceptedResponseSchema,
  SignupCompletedResponseSchema,
  SlugAvailabilityResponseSchema,
  type InviteAcceptInput,
  type InviteLookupInput,
  type InvitePreviewResponse,
  type LoginInput,
  type RealtimeTicketResponse,
  type SessionPrincipal,
  type SignupAcceptedResponse,
  type SignupCompletedResponse,
  type SignupInput,
  type SignupResendInput,
  type SignupVerifyInput,
  type SlugAvailabilityResponse,
} from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { toApiRequestError } from '@/lib/api/error';
import type { ApiRequest } from '@/lib/api/request';

/**
 * The calls that have to be made **by the browser**, and the small transport that
 * makes them.
 *
 * Everything else in `lib/api` goes through `http.ts` on the server. These
 * cannot, and the reason is the same for most of them: sign-in, invite
 * acceptance and signup verification answer with `Set-Cookie`, and a cookie set
 * on a fetch made by the Next process belongs to the Next process, not to the
 * person signing in. Sending them from the browser — to the same-origin `/api`
 * path `next.config.mjs` rewrites to the API host — is what makes the session
 * cookie first-party under a white-label domain (TAR-39, Decision 3).
 *
 * The invite lookup has no cookie of its own, but it is on the same screen as the
 * accept and reads a token that only the browser can see, so it lives here too.
 * The realtime ticket is here because the socket it is for is opened by the
 * browser: a ticket minted for the Next process would be spent by nobody.
 *
 * ## Why the three signup calls that set no cookie are here too
 *
 * `POST /signup`, `POST /signup/resend` and `GET /signup/slug-available` answer
 * with no credential at all, so on that test alone they could have been server
 * actions. They are not, for two reasons that outlive the cookie one:
 *
 *   - **The API throttles them per caller** (`SIGNUP_POLICY`), and a server
 *     action would present the Next process as the caller for every visitor at
 *     once — five signups an hour for the whole deployment rather than five per
 *     person. The browser path at least reaches the API with the proxy chain the
 *     API's own `trust proxy` setting is configured to read.
 *   - **Availability is checked while somebody is typing.** A server action per
 *     keystroke is a round trip through a React server render to make one `GET`,
 *     and it cannot be aborted when the next keystroke supersedes it.
 *
 * No token is read, stored or forwarded by any of this: the browser holds the
 * cookie and sends it back on its own, which is the whole of the console's
 * session handling.
 *
 * Deliberately free of `server-only` and of the fixture transport, so it can be
 * imported from a client component. That also means the mock API mode does not
 * cover any of these — it pairs with the role stub, which bypasses the session
 * entirely, so nothing in that mode ever reaches a signed-out screen.
 */

const AUTH_PATH = '/v1/auth';
const INVITES_PATH = '/v1/invites';
const SIGNUP_PATH = '/v1/signup';

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

/**
 * `POST /api/v1/auth/realtime-ticket` — the credential the Socket.IO handshake
 * presents (TAR-180).
 *
 * The socket cannot use the session cookie: under a white-label custom domain
 * the browser sits on the tenant's host while the realtime server is on the
 * platform's, which makes that cookie third-party and therefore blocked. So the
 * ticket is fetched over the same-origin proxy — where the cookie *is*
 * first-party — and presented in the handshake instead.
 *
 * A `POST` because each call mints and stores a new credential, which is not
 * something a safe method may do or an intermediary may replay. The ticket is
 * single-use and lives about a minute, so it is fetched immediately before the
 * connection and never stored.
 */
export async function requestRealtimeTicket(): Promise<RealtimeTicketResponse> {
  const response = await browserRequest({
    method: 'POST',
    path: `${AUTH_PATH}/realtime-ticket`,
    body: {},
  });

  return RealtimeTicketResponseSchema.parse(response);
}

/**
 * `POST /api/v1/signup` — record the signup and mail the verification link.
 *
 * Answers `202`, not `201`, and the body names only the address and when the
 * link dies: nothing is provisioned yet, and a response that distinguished a new
 * signup from a repeat would be an oracle for which addresses have one in
 * flight. The console must not word those two cases differently either.
 *
 * Rejects with `conflict` (409) for a slug that is taken, `not_found` (404) when
 * self-signup is switched off for this deployment, and `rate_limited` (429) for
 * either of `SIGNUP_POLICY`'s two limits.
 */
export async function requestSignup(input: SignupInput): Promise<SignupAcceptedResponse> {
  const response = await browserRequest({ method: 'POST', path: SIGNUP_PATH, body: input });

  return SignupAcceptedResponseSchema.parse(response);
}

/**
 * `POST /api/v1/signup/verify` — spend the emailed token, provision the tenant,
 * and sign the new admin in.
 *
 * The one call in this file that both **creates** the account and sets the
 * session cookie, which is why it cannot be a server action any more than login
 * can. It rejects with `token_invalid` (410) for a link that is unknown, lapsed
 * or already spent — one code for all three, with which it was in `details`.
 *
 * ⚠️ The cookie it sets is scoped to the **platform** host this request was made
 * from, because the session cookie carries no `Domain` and a `__Host-` prefix
 * that forbids one (`apps/api/src/identity/session-cookie.ts`). The tenant it
 * just created lives on `primaryHostname`, which is a different host, so that
 * cookie does not travel there. `SignupVerifySection` is where that is dealt
 * with.
 */
export async function verifySignup(input: SignupVerifyInput): Promise<SignupCompletedResponse> {
  const response = await browserRequest({
    method: 'POST',
    path: `${SIGNUP_PATH}/verify`,
    body: input,
  });

  return SignupCompletedResponseSchema.parse(response);
}

/**
 * `POST /api/v1/signup/resend` — send the verification link again.
 *
 * Takes the address alone: the pending signup holds the rest, and accepting any
 * of it again would let a caller who knows an address change the workspace name
 * or slug it was signed up with.
 *
 * Always `202`, whether or not there was a signup to resend, for the same reason
 * `POST /signup` is. `SIGNUP_POLICY.resendsPerSignup` is counted on the pending
 * row, so exhausting it answers `rate_limited` rather than silently doing
 * nothing.
 */
export async function resendSignupVerification(
  input: SignupResendInput,
): Promise<SignupAcceptedResponse> {
  const response = await browserRequest({
    method: 'POST',
    path: `${SIGNUP_PATH}/resend`,
    body: input,
  });

  return SignupAcceptedResponseSchema.parse(response);
}

/**
 * `GET /api/v1/signup/slug-available?slug=` — so the form can say "taken" while
 * the customer is still typing rather than after they have gone to check their
 * inbox.
 *
 * `signal` is not optional in practice: the form calls this as somebody types,
 * and without it a slow answer for `acm` can land after the answer for `acme`
 * and overwrite it. `useSlugAvailability` owns that.
 *
 * Rejects with `validation_failed` (422) for a value `TenantSlugSchema` refuses,
 * which is why the caller checks the shape first — a check spent on a slug the
 * API will not even look up is one taken off
 * `SIGNUP_POLICY.slugChecksPerIpPerMinute`.
 */
export async function checkSlugAvailability(
  slug: string,
  signal?: AbortSignal,
): Promise<SlugAvailabilityResponse> {
  const query = new URLSearchParams({ slug });
  const response = await browserRequest({
    method: 'GET',
    path: `${SIGNUP_PATH}/slug-available?${query.toString()}`,
    signal,
  });

  return SlugAvailabilityResponseSchema.parse(response);
}

/**
 * A request this transport can make, which is `ApiRequest` plus the one thing a
 * *browser* call needs that a server-side one does not: a way to be given up on.
 * Only the availability check uses it, and only because the value it is about
 * changes under it.
 */
type BrowserApiRequest = ApiRequest & { readonly signal?: AbortSignal };

async function browserRequest(request: BrowserApiRequest): Promise<unknown> {
  if (typeof window === 'undefined') {
    // A server-side call here would set the cookie on the wrong machine, and the
    // failure would look like "sign-in silently does nothing". Fail loudly.
    throw new Error('This request must be made by the browser; use apiRequest on the server.');
  }

  // A `GET` carries none, and a `content-type` on a request with no body is a
  // header describing something that is not there — enough, on its own, to turn
  // a simple cross-origin request into one that needs a preflight.
  const hasBody = request.body !== undefined;

  const response = await fetch(`${webEnv.apiBaseUrl}${request.path}`, {
    method: request.method,
    // Same-origin already, but explicit: the response's `Set-Cookie` is the
    // entire point of most of these calls.
    credentials: 'include',
    cache: 'no-store',
    signal: request.signal,
    headers: hasBody ? { 'content-type': 'application/json' } : {},
    body: hasBody ? JSON.stringify(request.body) : undefined,
  });

  if (!response.ok) {
    throw await toApiRequestError(response);
  }

  return (await response.json()) as unknown;
}
