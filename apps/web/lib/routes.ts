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
   * ⚠️ The page behind this lands with **TAR-60**, which owns the login and
   * invite-accept screens. The password screens link to it — a reset ends by
   * sending the user to sign in — so the entry exists here first, and TAR-60
   * fills it in without touching a single caller.
   */
  login: () => '/login',
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
} as const;

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
