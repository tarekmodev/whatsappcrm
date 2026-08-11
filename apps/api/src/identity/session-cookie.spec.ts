import { SESSION_COOKIE_NAME, SESSION_COOKIE_NAME_SECURE } from '@whatsappcrm/contracts';
import type { Request, Response } from 'express';
import {
  clearSessionCookie,
  isSecureCookieConfigured,
  sessionCookieOptions,
  sessionTokenFrom,
  setSessionCookie,
} from './session-cookie';

function requestWith(cookieHeader: string | undefined): Request {
  return { headers: cookieHeader === undefined ? {} : { cookie: cookieHeader } } as Request;
}

describe('the session cookie', () => {
  describe('reading SESSION_COOKIE_SECURE', () => {
    it.each([
      ['absent', undefined],
      ['the boolean true', true],
      // The trap: `ConfigService.get` can answer from `process.env`, where this
      // is a string — and `'false'` is truthy. Getting it wrong the other way
      // would ship a session cookie without `Secure`.
      ['the string "true"', 'true'],
    ])('treats %s as secure', (_label, configured) => {
      expect(isSecureCookieConfigured(configured)).toBe(true);
    });

    it.each([
      ['the boolean false', false],
      ['the string "false"', 'false'],
    ])('treats %s as insecure', (_label, configured) => {
      expect(isSecureCookieConfigured(configured)).toBe(false);
    });
  });

  describe('attributes', () => {
    it('is httpOnly, Lax and rooted at /, whatever the environment', () => {
      for (const secure of [true, false]) {
        expect(sessionCookieOptions(secure)).toMatchObject({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure,
        });
      }
    });

    it('carries no Domain, ever', () => {
      // A cookie scoped to the platform's parent domain would be sent to every
      // tenant's subdomain underneath it. Its absence is the reason the
      // `__Host-` prefix can be used at all, and a browser enforces the pair.
      expect(sessionCookieOptions(true)).not.toHaveProperty('domain');
    });

    it('expires with the session, not after it', () => {
      const { maxAge } = sessionCookieOptions(true);

      // Derived from `AUTH_POLICY.sessionAbsoluteMs`, so the browser drops a
      // cookie the server would reject anyway. Express takes milliseconds.
      expect(maxAge).toBe(30 * 24 * 60 * 60 * 1_000);
    });
  });

  describe('reading the presented token', () => {
    it.each([
      ['the secure spelling', `${SESSION_COOKIE_NAME_SECURE}=abc123`],
      ['the development spelling', `${SESSION_COOKIE_NAME}=abc123`],
      ['one among several', `theme=dark; ${SESSION_COOKIE_NAME_SECURE}=abc123; locale=en`],
    ])('finds %s', (_label, header) => {
      expect(sessionTokenFrom(requestWith(header))).toBe('abc123');
    });

    it('prefers the __Host- cookie when both are present', () => {
      // A plain cookie planted beside a `__Host-` one must not take precedence:
      // only the prefixed one had the browser's rules enforced on it.
      const header = `${SESSION_COOKIE_NAME}=planted; ${SESSION_COOKIE_NAME_SECURE}=genuine`;

      expect(sessionTokenFrom(requestWith(header))).toBe('genuine');
    });

    it.each([
      ['no Cookie header at all', undefined],
      ['other cookies only', 'theme=dark; locale=en'],
      ['the name with an empty value', `${SESSION_COOKIE_NAME_SECURE}=`],
      ['a malformed pair', 'novalue'],
    ])('answers null for %s', (_label, header) => {
      expect(sessionTokenFrom(requestWith(header))).toBeNull();
    });

    it('hands a malformed percent-escape back as a token rather than throwing', () => {
      // `decodeURIComponent('%zz')` throws `URIError`, which is not an
      // `ApiException` and so would escape the filter as a 500. The value is
      // returned as-is and fails to match a session row, which is the 401 every
      // other unusable cookie already produces.
      expect(sessionTokenFrom(requestWith(`${SESSION_COOKIE_NAME_SECURE}=%zz`))).toBe('%zz');
    });
  });

  describe('writing', () => {
    it('sets the name the environment calls for', () => {
      const cookie = jest.fn();
      const response = { cookie } as unknown as Response;

      setSessionCookie(response, false, 'token-value');

      expect(cookie).toHaveBeenCalledWith(
        SESSION_COOKIE_NAME,
        'token-value',
        expect.objectContaining({ secure: false }),
      );
    });

    it('clears both spellings on logout', () => {
      const cleared: { name: string; options: Record<string, unknown> }[] = [];
      const response = {
        clearCookie: (name: string, options: Record<string, unknown>) => {
          cleared.push({ name, options });
        },
      } as unknown as Response;

      clearSessionCookie(response, true);

      // Flipping SESSION_COOKIE_SECURE changes which name is issued. Clearing
      // only the current one leaves the other in the browser, presented on
      // every request and matching nothing — a 401 loop at a login screen.
      expect(cleared.map((call) => call.name)).toEqual([
        SESSION_COOKIE_NAME_SECURE,
        SESSION_COOKIE_NAME,
      ]);
      // No maxAge on a clear: a browser matches the clear to the set on name,
      // path, domain and secure flag, and nothing else.
      expect(cleared[0]?.options).not.toHaveProperty('maxAge');
    });
  });
});
