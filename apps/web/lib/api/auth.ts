import {
  InvitePreviewResponseSchema,
  SessionResponseSchema,
  type InviteAcceptInput,
  type InviteLookupInput,
  type InvitePreviewResponse,
  type LoginInput,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import { browserApiRequest } from '@/lib/api/browser';

/**
 * The three unauthenticated endpoints from ADR 0005's "Public — no session
 * required" list that the console calls: sign in, look an invitation up, and
 * accept it.
 *
 * All three go through the browser transport. Two of them answer with the
 * session cookie, and the third is on the same screen as one that does. No token
 * is read, stored or forwarded by any code here — the browser holds the cookie
 * and sends it back on its own, which is the whole of the frontend's session
 * handling.
 */

const AUTH_PATH = '/v1/auth';
const INVITES_PATH = '/v1/invites';

export async function login(input: LoginInput): Promise<SessionPrincipal> {
  const response = await browserApiRequest({
    method: 'POST',
    path: `${AUTH_PATH}/login`,
    body: input,
  });

  return SessionResponseSchema.parse(response).user;
}

export async function lookupInvite(input: InviteLookupInput): Promise<InvitePreviewResponse> {
  const response = await browserApiRequest({
    method: 'POST',
    path: `${INVITES_PATH}/lookup`,
    body: input,
  });

  return InvitePreviewResponseSchema.parse(response);
}

export async function acceptInvite(input: InviteAcceptInput): Promise<SessionPrincipal> {
  const response = await browserApiRequest({
    method: 'POST',
    path: `${INVITES_PATH}/accept`,
    body: input,
  });

  return SessionResponseSchema.parse(response).user;
}
