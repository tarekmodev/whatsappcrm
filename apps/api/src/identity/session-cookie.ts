import { SESSION_COOKIE_ATTRIBUTES, sessionCookieName } from '@whatsappcrm/contracts';
import type { CookieOptions, Request, Response } from 'express';

/**
 * Reading and writing the one cookie this platform sets.
 *
 * Every attribute comes from `SESSION_COOKIE_ATTRIBUTES` in the contract rather
 * than being spelled out here, so the API, the Next.js proxy and TAR-63's tests
 * cannot drift: a `Path` or `SameSite` that differs between the set and the
 * clear is a cookie that never actually goes away.
 *
 * Note what is deliberately absent: **`Domain`**. A cookie scoped to the
 * platform's parent domain would be sent to every tenant subdomain under it,
 * which under white-label custom domains is a cross-tenant credential leak. The
 * `__Host-` prefix makes its absence a browser-enforced rule rather than a
 * code-review convention — a browser rejects a `__Host-` cookie carrying
 * `Domain`, missing `Secure`, or with any `Path` other than `/`.
 */

/**
 * Reads `SESSION_COOKIE_SECURE` into a boolean, defaulting to secure.
 *
 * Normalised in one place, and comparing against both spellings, because
 * `ConfigService.get` answers from the validated environment (where
 * `z.stringbool()` has already produced a boolean) but falls through to
 * `process.env` for anything the schema did not produce — and there the value
 * is the **string** `'false'`, which is truthy. The same trap `AUTH_STUB_ON`
 * exists to avoid, one key over.
 *
 * Absent means secure. A misconfiguration that drops `Secure` and the
 * `__Host-` prefix is a cookie a network attacker can read; one that adds them
 * where they are not wanted breaks a developer's localhost and nothing else.
 */
export function isSecureCookieConfigured(configured: unknown): boolean {
  return configured !== false && configured !== 'false';
}

/**
 * Set-Cookie attributes for `res.cookie`, with `secure` supplied by the
 * environment. `maxAge` is milliseconds here — Express converts to the seconds
 * the header grammar wants — while the contract states it in seconds, hence the
 * one conversion in this file.
 */
export function sessionCookieOptions(secure: boolean): CookieOptions {
  return {
    ...SESSION_COOKIE_ATTRIBUTES,
    secure,
    maxAge: SESSION_COOKIE_ATTRIBUTES.maxAge * 1_000,
  };
}

/**
 * Attributes for clearing it. Identical to the above minus the lifetime:
 * a browser only drops a cookie when the clear matches the set on name, path,
 * domain and secure flag, so this is derived rather than written twice.
 */
export function clearSessionCookieOptions(secure: boolean): CookieOptions {
  const options = sessionCookieOptions(secure);

  delete options.maxAge;

  return options;
}

export function setSessionCookie(response: Response, secure: boolean, token: string): void {
  response.cookie(sessionCookieName(secure), token, sessionCookieOptions(secure));
}

/**
 * Clears **both** spellings of the name, not just the configured one.
 *
 * Flipping `SESSION_COOKIE_SECURE` changes which name is issued, and a logout
 * that cleared only the current spelling would leave the other one sitting in
 * the browser — presented on every subsequent request, matching no live row,
 * and answering 401 to somebody who is looking at a login screen wondering why
 * it will not take. Clearing a cookie that is not there costs one header.
 */
export function clearSessionCookie(response: Response, secure: boolean): void {
  for (const name of [sessionCookieName(true), sessionCookieName(false)]) {
    response.clearCookie(name, clearSessionCookieOptions(secure));
  }
}

/**
 * The presented session token, or `null`.
 *
 * Reads the raw `Cookie` header rather than adding `cookie-parser`. One cookie
 * is the whole of this application's interest in them, and a middleware that
 * parses every request's cookies to serve one route is cost without benefit —
 * the header grammar is `name=value` pairs separated by `;`, and that is the
 * entire parser.
 *
 * **Both spellings are accepted on the way in**, whatever the flag says, so
 * that flipping `SESSION_COOKIE_SECURE` does not sign a developer out
 * mid-session. The secure name wins when both are present: a `__Host-` cookie
 * is the one the browser has enforced the rules on, so a plain cookie planted
 * beside it must not take precedence. Accepting the plain name grants nothing
 * on its own — the value still has to match a live row in the tenant in scope.
 */
export function sessionTokenFrom(request: Request): string | null {
  return (
    readCookie(request, sessionCookieName(true)) ?? readCookie(request, sessionCookieName(false))
  );
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.cookie;

  if (header === undefined) {
    return null;
  }

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');

    if (separator === -1) {
      continue;
    }

    if (pair.slice(0, separator).trim() === name) {
      // Read raw rather than percent-decoded. The token we issue is base64url,
      // which contains nothing that needs escaping, so decoding can only ever
      // change a value we would reject anyway — and `decodeURIComponent` throws
      // `URIError` on a malformed escape. That throw is not an `ApiException`,
      // so `Cookie: wac_session=%zz` would leave the filter and answer 500
      // instead of the 401 every other unusable cookie produces.
      const value = pair.slice(separator + 1).trim();

      return value === '' ? null : value;
    }
  }

  return null;
}
