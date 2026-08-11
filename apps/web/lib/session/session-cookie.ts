import 'server-only';

import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_NAME_SECURE } from '@whatsappcrm/contracts';

/**
 * Forwards the browser's session cookie on a server-side call to the API.
 *
 * Server-side rendering and server actions run on the Next process, which is not
 * the browser: `credentials: 'include'` does nothing there, so a call that needs
 * the caller's identity has to carry the cookie explicitly. Every such call goes
 * through here rather than reading `cookies()` itself — the session bootstrap in
 * `session.ts` and the password-change action both need it, and two copies is how
 * one of them ends up reading the wrong cookie name.
 *
 * **Both spellings are accepted.** The API names the cookie from
 * `SESSION_COOKIE_SECURE`: `__Host-wac_session` wherever it is deployed, plain
 * `wac_session` only on local HTTP, where Safari refuses a `__Host-` cookie at
 * all. The console cannot read that server-side flag, so it looks for the secure
 * name first and falls back — and echoes back whichever name it actually found,
 * because the API matches on the name it set.
 */
export async function sessionCookieHeaders(): Promise<Record<string, string>> {
  const cookieStore = await cookies();

  for (const name of SESSION_COOKIE_NAMES) {
    const value = cookieStore.get(name)?.value;

    if (value !== undefined) {
      return { cookie: `${name}=${value}` };
    }
  }

  // No cookie to forward. The API answers 401, which is the same answer it would
  // give to a forged one — the console never decides that question itself.
  return {};
}

/**
 * Drops the browser's session cookie after a sign-out.
 *
 * The API clears its own on the logout response, but that response comes back to
 * the Next process, not to the person signing out — so without this the browser
 * would keep sending a session id the API has already revoked, and every request
 * would take the long way round to the sign-in screen.
 *
 * Both spellings, unconditionally: deleting a cookie that was never set is a
 * no-op, and guessing which name is in play is how a sign-out leaves one behind.
 */
export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();

  for (const name of SESSION_COOKIE_NAMES) {
    cookieStore.delete(name);
  }
}

/** Secure spelling first: it is the one every deployed environment uses. */
const SESSION_COOKIE_NAMES = [SESSION_COOKIE_NAME_SECURE, SESSION_COOKIE_NAME] as const;
