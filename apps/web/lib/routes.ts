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
  forbidden: () => '/forbidden',
  login: (query?: LoginQuery) =>
    withQuery('/login', { [searchParamKeys.redirectTo]: query?.redirectTo }),
  /**
   * The target of the invitation email. The token travels in the URL *fragment*
   * (`/invite#token=…`), which browsers never send to a server, so it is not part
   * of this function's output — the mailer appends it (ADR 0005).
   */
  invite: () => '/invite',
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
 * Narrows an untrusted `?next=` value to a path inside this app.
 *
 * Anything else is dropped rather than corrected: a value like
 * `//evil.example.com` or `https://evil.example.com` is a browser-protocol-relative
 * URL, and following it after a successful sign-in is an open redirect that hands
 * a freshly authenticated user to somebody else's site. A backslash is rejected
 * for the same reason — some browsers normalise `/\` to `//`.
 */
export function parseRedirectPath(value: string | undefined, fallback: string): string {
  if (value === undefined || !value.startsWith('/')) {
    return fallback;
  }

  return value.startsWith('//') || value.startsWith('/\\') ? fallback : value;
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
