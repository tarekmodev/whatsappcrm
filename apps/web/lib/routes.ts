import type { ConversationListQuery } from '@whatsappcrm/contracts';

/**
 * The central route map. No route string is written anywhere else in the app —
 * a rename happens here and `pnpm typecheck` finds every caller.
 */
export const routes = {
  home: () => '/',
  inbox: (query?: InboxQuery) => withQuery('/inbox', inboxSearchParams(query)),
  settings: () => '/settings',
  settingsPeople: (query?: PeopleQuery) => withQuery('/settings/people', peopleSearchParams(query)),
  settingsAssignment: () => '/settings/assignment',
  settingsSecurity: () => '/settings/security',
  /**
   * Sign in. `redirectTo` is where the user was heading when the guard turned
   * them away (TAR-62), carried as `?next=` and read back through
   * `parseRedirectPath` — never followed raw.
   *
   * ⚠️ The page behind this lands with **TAR-60**, which owns the login and
   * invite-accept screens. The password screens link to it — a reset ends by
   * sending the user to sign in — so the entry exists here first, and TAR-60
   * fills it in without touching a single caller.
   */
  login: (query?: LoginQuery) =>
    withQuery('/login', { [searchParamKeys.redirectTo]: query?.redirectTo }),
  /**
   * The target of the invitation email, also owned by TAR-60. The token travels
   * in the URL *fragment* (`/invite#token=…`), which browsers never send to a
   * server, so it is not part of this function's output.
   *
   * Listed here because the session guard needs to know the path is reachable
   * without a session — an invitee has no account yet, and a guard that bounced
   * them to sign in would make the invitation impossible to accept.
   */
  invite: () => '/invite',
  forgotPassword: () => '/forgot-password',
  /**
   * The target of the link in a password-reset email. The path is fixed by the
   * API's `RESET_PASSWORD_LINK_PATH` (`apps/api/src/identity/mailer/mailer.port.ts`),
   * which is what the mailer puts in front of `#token=…`; `routes.test.ts` pins
   * the spelling so the two cannot drift into a dead link.
   */
  resetPassword: () => '/reset-password',
  forbidden: () => '/forbidden',
} as const;

/** Query keys are named once so a link and the page that reads it cannot drift. */
export const searchParamKeys = {
  inboxScope: 'scope',
  inboxStatus: 'status',
  peopleTab: 'tab',
  peopleRole: 'role',
  peopleQuery: 'q',
  /** Where sign-in sends the user afterwards. Read through `parseRedirectPath`. */
  redirectTo: 'next',
} as const;

export interface LoginQuery {
  redirectTo?: string;
}

/**
 * The origin an untrusted `?next=` is resolved against. `.invalid` is reserved by
 * RFC 2606 and can never be a real host, so a value that still resolves here is
 * one that named no host of its own.
 */
const REDIRECT_ORIGIN = 'https://redirect.invalid';

/**
 * Narrows an untrusted `?next=` value to a path inside this app.
 *
 * Anything else is dropped rather than corrected: a value like
 * `//evil.example.com` or `https://evil.example.com` is a browser-protocol-relative
 * URL, and following it after a successful sign-in is an open redirect that hands
 * a freshly authenticated user to somebody else's site.
 *
 * The check is a real URL resolution, not string inspection, because those two
 * disagree: the WHATWG parser strips tab, CR and LF *before* resolving, so
 * `/{tab}/evil.example.com` reads as `/…` to every `startsWith` but resolves to
 * `https://evil.example.com/`. It also treats a backslash as a slash for special
 * schemes. Only the parser knows where the router will actually go, so this asks
 * it — and returns its answer rather than the raw input, so nothing downstream
 * can re-parse the same string differently.
 */
export function parseRedirectPath(value: string | undefined, fallback: string): string {
  // An in-app target is absolute-path-relative; a bare `inbox` is not a route
  // this app ever links to, so it stays a fallback rather than being corrected.
  if (value === undefined || !value.startsWith('/')) {
    return fallback;
  }

  let resolved: URL;

  try {
    resolved = new URL(value, REDIRECT_ORIGIN);
  } catch {
    return fallback;
  }

  return resolved.origin === REDIRECT_ORIGIN
    ? `${resolved.pathname}${resolved.search}${resolved.hash}`
    : fallback;
}

export type InboxScope = ConversationListQuery['scope'];
export type ConversationStatusFilter = NonNullable<ConversationListQuery['status']>;
export const PEOPLE_TABS = ['agents', 'teams'] as const;
export type PeopleTab = (typeof PEOPLE_TABS)[number];

export interface InboxQuery {
  scope?: InboxScope;
  status?: ConversationStatusFilter;
}

export interface PeopleQuery {
  tab?: PeopleTab;
  role?: string;
  q?: string;
}

function inboxSearchParams(query: InboxQuery | undefined): Record<string, string | undefined> {
  return {
    [searchParamKeys.inboxScope]: query?.scope,
    [searchParamKeys.inboxStatus]: query?.status,
  };
}

function peopleSearchParams(query: PeopleQuery | undefined): Record<string, string | undefined> {
  return {
    [searchParamKeys.peopleTab]: query?.tab,
    [searchParamKeys.peopleRole]: query?.role,
    [searchParamKeys.peopleQuery]: query?.q,
  };
}

/**
 * Builds `path?a=1&b=2` with proper encoding. Hand-concatenating a URL is how a
 * search term containing `&` silently becomes two filters.
 */
function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, value);
    }
  }

  const serialised = search.toString();

  return serialised.length > 0 ? `${path}?${serialised}` : path;
}

/** Narrows an untrusted `?tab=` value; anything unexpected falls back to the default. */
export function parsePeopleTab(value: string | undefined): PeopleTab {
  return PEOPLE_TABS.find((tab) => tab === value) ?? 'agents';
}
