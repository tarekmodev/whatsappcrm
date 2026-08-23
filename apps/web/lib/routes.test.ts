import { describe, expect, it } from 'vitest';
import {
  ADMIN_DOMAIN_STATUS_DEFAULT,
  parseAdminDomainStatus,
  parseOnboardingStep,
  parseRedirectPath,
  routes,
} from './routes';

describe('routes', () => {
  /**
   * The API builds the link in a password-reset email as
   * `https://{tenantHost}${RESET_PASSWORD_LINK_PATH}#token=…`, with the path
   * declared in `apps/api/src/identity/mailer/mailer.port.ts`. The console cannot
   * import that constant — the two packages do not depend on each other — so this
   * is the assertion that stops the emailed link and the page it points at
   * drifting into a 404 that only shows up in somebody's inbox.
   *
   * Promoting the constant into `@whatsappcrm/contracts` would remove the need
   * for this; it is a contract change and belongs to TAR-53, not here.
   */
  it('serves the reset page on the path the API mails out', () => {
    expect(routes.resetPassword()).toBe('/reset-password');
  });

  /**
   * The same assertion for self-signup's own emailed link, which the API builds
   * as `https://{platformHost}${VERIFY_LINK_PATH}#token=…` with the path declared
   * in `apps/api/src/signup/tenant-signup.service.ts`.
   *
   * Worth pinning twice over: unlike a reset, the recipient of this link has no
   * account to fall back on and no admin to ask for another one, so a 404 here is
   * a workspace that can never be created and a slug that stays reserved until it
   * lapses.
   */
  it('serves the signup verification page on the path the API mails out', () => {
    expect(routes.verifySignup()).toBe('/verify');
  });

  it('serves the signup form on a bare path, because nothing about it is shareable', () => {
    expect(routes.signup()).toBe('/signup');
  });

  it('builds a query string only when there is something to put in it', () => {
    expect(routes.settingsPeople()).toBe('/settings/people');
    expect(routes.settingsPeople({ tab: 'teams' })).toBe('/settings/people?tab=teams');
  });

  it('encodes a search term rather than letting it become a second filter', () => {
    expect(routes.settingsPeople({ q: 'a&b' })).toBe('/settings/people?q=a%26b');
  });
});

describe('routes.contacts', () => {
  const TAG_ID = '0192f00b-0000-7000-8000-000000000b01';

  it('is a bare path for the unfiltered directory', () => {
    expect(routes.contacts()).toBe('/contacts');
  });

  /**
   * The two filters are what makes "everyone tagged VIP" a link rather than a
   * sequence of clicks somebody has to describe. `tag`, not `tagId`: a shared
   * link is read by people, and the value being an id is the API's business.
   */
  it('carries both filters, spelled as the URL spells them', () => {
    expect(routes.contacts({ q: 'fatima', tagId: TAG_ID })).toBe(
      `/contacts?q=fatima&tag=${TAG_ID}`,
    );
  });

  it('drops an empty search rather than writing a filter that says nothing', () => {
    expect(routes.contacts({ q: '', tagId: TAG_ID })).toBe(`/contacts?tag=${TAG_ID}`);
  });

  it('points at one contact', () => {
    expect(routes.contact('0192f003-0000-7000-8000-000000000301')).toBe(
      '/contacts/0192f003-0000-7000-8000-000000000301',
    );
  });
});

describe('the platform-operator console', () => {
  /**
   * The prefix is load-bearing rather than cosmetic: `proxy.ts` reads it to
   * decide which of the app's two credentials a request is missing, and the
   * operator's cookie is scoped to it so the platform token never rides along on
   * a call to a tenant's API. A rename here without the same rename in
   * `admin-paths.ts` would silently open the console to anyone.
   */
  it.each([
    routes.adminSignIn(),
    routes.adminTenants(),
    routes.adminTenant('northwind'),
    routes.adminDomains(),
    routes.adminWebhookEvents(),
  ])('puts %s under the /admin prefix', (path) => {
    expect(path.startsWith('/admin')).toBe(true);
  });

  /**
   * The one route in the map whose parameter is typed by a person rather than
   * read back from the API, so it is the one that has to encode.
   */
  it('encodes the slug an operator typed', () => {
    expect(routes.adminTenant('north/wind')).toBe('/admin/tenants/north%2Fwind');
  });

  it('carries the trail cursor, and drops it on the newest page', () => {
    expect(routes.adminTenant('northwind')).toBe('/admin/tenants/northwind');
    expect(routes.adminTenant('northwind', { cursor: 'abc' })).toBe(
      '/admin/tenants/northwind?cursor=abc',
    );
  });

  /**
   * A parameter that says exactly what the API would have done anyway is one
   * more thing in a shared URL that means nothing to whoever receives it.
   */
  it('spells the queue’s default half as the bare route', () => {
    expect(routes.adminDomains()).toBe('/admin/domains');
    expect(routes.adminDomains({ status: 'live' })).toBe('/admin/domains?status=live');
  });

  it('narrows an untrusted queue filter to a half the API answers', () => {
    expect(parseAdminDomainStatus('live')).toBe('live');
    expect(parseAdminDomainStatus('verified')).toBe('verified');
    expect(parseAdminDomainStatus('nonsense')).toBe(ADMIN_DOMAIN_STATUS_DEFAULT);
    expect(parseAdminDomainStatus(undefined)).toBe(ADMIN_DOMAIN_STATUS_DEFAULT);
  });
});

describe('routes.login', () => {
  it('is a bare path when there is nowhere in particular to return to', () => {
    expect(routes.login()).toBe('/login');
  });

  it('carries the return path encoded, not concatenated', () => {
    expect(routes.login({ redirectTo: '/settings/people?tab=teams' })).toBe(
      '/login?next=%2Fsettings%2Fpeople%3Ftab%3Dteams',
    );
  });

  /**
   * `redirectToLogin` passes an empty string when the proxy did not run, and
   * relies on this: a `?next=` with nothing in it would make sign-in redirect to
   * the site root instead of its own landing page.
   */
  it('drops an empty return path rather than emitting an empty parameter', () => {
    expect(routes.login({ redirectTo: '' })).toBe('/login');
  });
});

/**
 * `?next=` is attacker-controlled: anybody can send a link to the sign-in screen,
 * and the guard itself writes the parameter from a request header. Following either
 * blindly hands a user who has *just* authenticated to whatever host the value
 * named — which is exactly when they are least likely to check the address bar.
 */
describe('parseRedirectPath', () => {
  const FALLBACK = '/inbox';

  it('keeps an in-app path, query and all', () => {
    expect(parseRedirectPath('/settings/people?tab=teams', FALLBACK)).toBe(
      '/settings/people?tab=teams',
    );
  });

  it('falls back when nothing was asked for', () => {
    expect(parseRedirectPath(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it('refuses an absolute URL', () => {
    expect(parseRedirectPath('https://evil.example.com/inbox', FALLBACK)).toBe(FALLBACK);
  });

  it('refuses a protocol-relative URL, which a browser reads as another host', () => {
    expect(parseRedirectPath('//evil.example.com/inbox', FALLBACK)).toBe(FALLBACK);
  });

  it('refuses the backslash spelling the URL parser reads as //', () => {
    expect(parseRedirectPath('/\\evil.example.com', FALLBACK)).toBe(FALLBACK);
  });

  /**
   * The bypass a string check cannot see: the WHATWG parser strips tab, CR and LF
   * before resolving, so each of these looks like an in-app path to `startsWith`
   * and resolves to `https://evil.example.com/` once the router parses it.
   */
  it.each([
    ['tab', '/\t/evil.example.com'],
    ['newline', '/\n/evil.example.com'],
    ['carriage return', '/\r/evil.example.com'],
    ['tab then backslash', '/\t\\evil.example.com'],
  ])('refuses a host smuggled past a string check with a %s', (_label, value) => {
    expect(parseRedirectPath(value, FALLBACK)).toBe(FALLBACK);
  });

  it('refuses a relative path, which is not a shape this app ever links to', () => {
    expect(parseRedirectPath('inbox', FALLBACK)).toBe(FALLBACK);
  });

  it('returns what the router will resolve, not the raw input', () => {
    expect(parseRedirectPath('/settings/../inbox', FALLBACK)).toBe('/inbox');
  });
});

describe('routes.onboarding', () => {
  it('is a bare path when no step is named', () => {
    expect(routes.onboarding()).toBe('/onboarding');
  });

  it('carries the open step, so a shared link resumes the walkthrough', () => {
    expect(routes.onboarding({ stepId: 'invite_agents' })).toBe('/onboarding?step=invite_agents');
  });
});

describe('parseOnboardingStep', () => {
  it('accepts a step the contract names', () => {
    expect(parseOnboardingStep('set_branding')).toBe('set_branding');
  });

  it('drops anything else, because the URL is untrusted', () => {
    // `undefined` rather than a default: only the checklist knows which step is
    // the one still pending.
    expect(parseOnboardingStep('../../etc/passwd')).toBeUndefined();
    expect(parseOnboardingStep(undefined)).toBeUndefined();
  });
});
