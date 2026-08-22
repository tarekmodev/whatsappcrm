import {
  ONBOARDING_STEP_IDS,
  type ConversationListQuery,
  type OnboardingStepId,
  type ReportScope,
  type TicketListQuery,
} from '@whatsappcrm/contracts';

/**
 * The central route map. No route string is written anywhere else in the app —
 * a rename happens here and `pnpm typecheck` finds every caller.
 */
export const routes = {
  home: () => '/',
  inbox: (query?: InboxQuery) => withQuery('/inbox', inboxSearchParams(query)),
  /**
   * The contact directory (TAR-33). The search term and the tag filter both ride
   * in the URL, because "everyone tagged VIP" is a link a supervisor sends, not a
   * sequence of clicks they describe.
   *
   * One `tagId`, not a set: `ContactListQuerySchema` takes a single optional
   * `tagId`, and offering a multi-select the API answers by ignoring all but one
   * would be a filter that silently lies.
   */
  contacts: (query?: ContactsQuery) => withQuery('/contacts', contactsSearchParams(query)),
  /** One contact: their identity, their tags and the tenant's custom fields. */
  contact: (contactId: string) => `/contacts/${contactId}`,
  /**
   * The ticket queue. Scope, status and priority all ride in the URL, so a
   * refresh, a copied link and the back button reproduce the same view.
   *
   * Sort order is deliberately *not* a parameter: the queue has exactly one
   * order — `priority DESC, createdAt DESC, id DESC` — and it is the API's, not
   * the console's (ADR 0006 §6).
   */
  tickets: (query?: TicketQueueQuery) => withQuery('/tickets', ticketSearchParams(query)),
  /** One ticket, where its status and priority are changed. */
  ticket: (ticketId: string) => `/tickets/${ticketId}`,
  /**
   * The supervisor's performance dashboard (TAR-30, ADR 0009).
   *
   * The applied range rides in the URL, and that is load-bearing rather than
   * tidy: the metrics request and — once TAR-431 lands — the export URL are both
   * derived from this one value, so the export cannot hold its own copy of the
   * filters because it has nowhere to hold it.
   */
  reports: (query?: ReportQuery) => withQuery('/reports', reportSearchParams(query)),
  /**
   * The guided onboarding checklist a new tenant admin lands in after signup, and
   * returns to afterwards (TAR-36, TAR-407).
   *
   * `step` is in the URL rather than in component state because it is the thing
   * an admin shares and returns to — "carry on from connecting your number" is a
   * link. It also keeps the page a server component: which step is open is read
   * from the URL, so nothing about the walkthrough needs client state.
   */
  onboarding: (query?: OnboardingQuery) =>
    withQuery('/onboarding', { [searchParamKeys.onboardingStep]: query?.stepId }),
  settings: () => '/settings',
  settingsPeople: (query?: PeopleQuery) => withQuery('/settings/people', peopleSearchParams(query)),
  settingsAssignment: (query?: AssignmentQuery) =>
    withQuery('/settings/assignment', {
      [searchParamKeys.assignmentReason]: query?.deferredReason,
    }),
  /**
   * The workspace itself: its profile, its plan state and its seat usage
   * (TAR-409).
   *
   * `workspace`, not `tenant` or `organisation`. TAR-409 asks for an
   * "organization profile" and `docs/STYLE.md` overrules the word: *tenant* is
   * our name for the row, *workspace* is the only word the console says on
   * screen for it, and *organisation* is on the forbidden-synonym list. This
   * path is read by a customer, so it takes the on-screen word.
   */
  settingsWorkspace: () => '/settings/workspace',
  /**
   * Where an admin defines the tenant's contact schema — 0002 amendment 10's
   * `custom_field_defs` surface (TAR-33, TAR-476).
   *
   * Under Settings rather than beside the directory: it is tenant configuration
   * gated on `tenant:settings`, and every agent who *reads* those fields on a
   * profile holds only `contact:read`. Putting it on `/contacts` would mean a
   * tab most of the workspace is refused.
   */
  settingsCustomFields: () => '/settings/custom-fields',
  /**
   * The tenant's shared canned-response library (TAR-31, TAR-575).
   *
   * `saved-replies`, not `canned-responses`. `docs/STYLE.md` fixes *canned
   * response* as the word in code and *saved reply* as the console's word on
   * screen, and this path is read by a customer — the same reasoning that makes
   * `settingsWorkspace` `/settings/workspace` rather than `/settings/tenant`.
   * The API route it writes to keeps the contract's spelling.
   */
  settingsSavedReplies: () => '/settings/saved-replies',
  /**
   * The automation builder (TAR-27). Its own settings section rather than a
   * fourth panel on Assignment: a routing rule decides where a *conversation*
   * goes, while a workflow writes to a *ticket* — and the Assignment page is
   * already three independently-streamed sections.
   *
   * No query parameters. Which workflow is being edited, tested or inspected is
   * dialog state rather than a shareable view: every one of those is a write or
   * a per-principal read, so a copied link could only ever reopen a dialog over
   * a list the recipient may not be entitled to.
   */
  settingsWorkflows: () => '/settings/workflows',
  /** Where a tenant admin connects its own WhatsApp Business Account (TAR-169). */
  settingsWhatsApp: () => '/settings/whatsapp',
  /** Logo, favicon and the two brand colours (TAR-29). */
  settingsBranding: () => '/settings/branding',
  /**
   * The tenant's own hostnames (TAR-29). Separate from branding because the two
   * are different authorities — `domain:write` controls DNS and therefore every
   * invite and reset link, `branding:write` controls a colour.
   */
  settingsDomains: () => '/settings/domains',
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
  /**
   * Which thread the inbox has open. A query parameter rather than a nested
   * route because the list and the thread share one screen and one set of
   * filters, and a Next layout receives no `searchParams` to render the list
   * from (TAR-71).
   */
  inboxConversation: 'conversation',
  /** The inbox's search term. Same spelling as `peopleQuery`, on purpose. */
  inboxQuery: 'q',
  /**
   * The queue's three filters. Spelled exactly as `TicketListQuerySchema` names
   * them, so a URL parameter and the query it becomes cannot drift.
   */
  ticketScope: 'scope',
  ticketStatus: 'status',
  ticketPriority: 'priority',
  /**
   * The supervisor's "show me only what has breached" view (TAR-26). Named
   * `overdue` in the URL rather than `breachedOnly`: a shared link is read by
   * people, and "breached" is the contract's word for it, not theirs. The query
   * this becomes is `TicketListQuery.breachedOnly`.
   */
  ticketOverdue: 'overdue',
  /**
   * The dashboard's applied range, spelled exactly as
   * `DashboardMetricsQuerySchema` names them so a URL parameter and the query it
   * becomes cannot drift. Both are tenant-local `YYYY-MM-DD` dates, never
   * instants: the tenant's timezone is the server's to apply (ADR 0009
   * decision 5), and a console that sent instants would be deciding it here.
   */
  reportFrom: 'from',
  reportTo: 'to',
  reportScope: 'scope',
  peopleTab: 'tab',
  peopleRole: 'role',
  peopleQuery: 'q',
  /**
   * The directory's search term. Spelled `q` like every other search in the app,
   * and passed straight through to `GET /contacts?q=`.
   */
  contactsQuery: 'q',
  /**
   * Which tag the directory is narrowed to. `tag` in the URL rather than
   * `tagId`: a shared link is read by people, and the value being an id is the
   * API's business. The query it becomes is `ContactListQuery.tagId`.
   */
  contactsTag: 'tag',
  /**
   * Which deferral reason the supervisor's flagged-ticket queue is narrowed to.
   * In the URL rather than component state because it is the thing a supervisor
   * shares — "everyone is at capacity, look" is a link, not a screenshot.
   */
  assignmentReason: 'reason',
  /**
   * Which onboarding step the checklist has open. Spelled `step` rather than
   * `onboardingStep`: the path already says which flow it belongs to, and a
   * shared link is read by people.
   */
  onboardingStep: 'step',
  /** Where sign-in sends the user afterwards. Read through `parseRedirectPath`. */
  redirectTo: 'next',
} as const;

export interface OnboardingQuery {
  /** Omitted means "open the first step still pending" — see `nextOnboardingStep`. */
  stepId?: OnboardingStepId;
}

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

/**
 * The scope tabs the inbox offers, in the order it offers them — the same three
 * for every role.
 *
 * An agent used to be capped at `assigned`. ADR 0002 amendment 4 rules that an
 * unclaimed conversation is visible to every agent on the tenant, because a
 * conversation is created by a customer writing in rather than by an agent, so a
 * thread nobody has claimed would otherwise be visible to nobody. The API's
 * `inboxScopeFilter` opens `unassigned` to every principal accordingly, and a
 * console that hid the tab would leave arriving customers unanswered.
 *
 * `all` is offered to everyone for the reason the API does not reject it: it
 * narrows to "mine ∪ my teams' ∪ unclaimed" rather than erroring. What that
 * narrowing looks like in the UI is `isConversationScopeNarrowed`'s job.
 */
export const INBOX_SCOPES = [
  'assigned',
  'unassigned',
  'all',
] as const satisfies readonly InboxScope[];

export type ConversationStatusFilter = NonNullable<ConversationListQuery['status']>;

export type TicketScope = TicketListQuery['scope'];
export type TicketStatusFilter = NonNullable<TicketListQuery['status']>;
export type TicketPriorityFilter = NonNullable<TicketListQuery['priority']>;

/**
 * The scopes the queue offers, in order.
 *
 * Narrower than the inbox's set on purpose. An unclaimed *conversation* is
 * visible to every agent — a customer wrote in, and a thread nobody has claimed
 * would otherwise be visible to nobody. An unassigned *ticket* is triaged work,
 * and `visibility.ts` keeps the narrow rule for it: `unassigned` needs
 * `ticket:read_all`. `TicketQueueFilters` drops the entry accordingly rather
 * than offering a scope the API answers empty.
 */
export const TICKET_SCOPES = [
  'assigned',
  'unassigned',
  'all',
] as const satisfies readonly TicketScope[];

/** Scopes every principal may ask for; `unassigned` is the one that is gated. */
export const TICKET_SCOPES_WITHOUT_READ_ALL = [
  'assigned',
  'all',
] as const satisfies readonly TicketScope[];

export interface TicketQueueQuery {
  scope?: TicketScope;
  /**
   * Omitted means the active queue — `open` and `pending` — which is the API's
   * own default and what makes "resolving a ticket moves it out of the queue"
   * true with no client change (ADR 0006 §6).
   */
  status?: TicketStatusFilter;
  priority?: TicketPriorityFilter;
  /**
   * Narrows to tickets whose SLA has breached. Absent and `false` are the same
   * view, so only `true` is ever written to the URL — a `?overdue=false` in a
   * shared link says nothing and looks like a filter that is switched off.
   */
  isOverdueOnly?: boolean;
}

export interface ReportQuery {
  /** Tenant-local `YYYY-MM-DD`, inclusive at both ends. */
  from?: string;
  to?: string;
  /**
   * Which tickets the aggregate covers. `all` is the contract's default and is
   * narrowed rather than refused for a caller without `report:read_all`, so it
   * is omitted from the URL — a parameter that names the default says nothing
   * and makes a shared link look filtered when it is not.
   */
  scope?: ReportScope;
}

export const PEOPLE_TABS = ['agents', 'teams'] as const;
export type PeopleTab = (typeof PEOPLE_TABS)[number];

export interface InboxQuery {
  scope?: InboxScope;
  status?: ConversationStatusFilter;
  /** The open thread. Omitted for the list-only view. */
  conversationId?: string;
  /** A search term, passed through to `GET /conversations?q=`. */
  q?: string;
}

export interface PeopleQuery {
  tab?: PeopleTab;
  role?: string;
  q?: string;
}

export interface ContactsQuery {
  /** Free text, matched by the API against name, phone and email. */
  q?: string;
  /** A single `TagSchema` id; omitted means every contact. */
  tagId?: string;
}

export interface AssignmentQuery {
  /** A `FallbackAssignmentReason`; omitted means every flagged ticket. */
  deferredReason?: string;
}

function inboxSearchParams(query: InboxQuery | undefined): Record<string, string | undefined> {
  return {
    [searchParamKeys.inboxScope]: query?.scope,
    [searchParamKeys.inboxStatus]: query?.status,
    [searchParamKeys.inboxConversation]: query?.conversationId,
    [searchParamKeys.inboxQuery]: query?.q,
  };
}

function ticketSearchParams(
  query: TicketQueueQuery | undefined,
): Record<string, string | undefined> {
  return {
    [searchParamKeys.ticketScope]: query?.scope,
    [searchParamKeys.ticketStatus]: query?.status,
    [searchParamKeys.ticketPriority]: query?.priority,
    // Only ever `'true'`. `withQuery` drops an `undefined`, which is what keeps
    // the default view's URL clean.
    [searchParamKeys.ticketOverdue]: query?.isOverdueOnly === true ? 'true' : undefined,
  };
}

function reportSearchParams(query: ReportQuery | undefined): Record<string, string | undefined> {
  return {
    [searchParamKeys.reportFrom]: query?.from,
    [searchParamKeys.reportTo]: query?.to,
    // `withQuery` drops an `undefined`, which is what keeps the default view's
    // URL to the two dates it is actually about.
    [searchParamKeys.reportScope]: query?.scope === 'assigned' ? 'assigned' : undefined,
  };
}

function contactsSearchParams(
  query: ContactsQuery | undefined,
): Record<string, string | undefined> {
  return {
    [searchParamKeys.contactsQuery]: query?.q,
    [searchParamKeys.contactsTag]: query?.tagId,
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

/**
 * Narrows an untrusted `?step=` value. `undefined` rather than a default, because
 * "no step named" and "a step named that does not exist" both mean the same thing
 * to the checklist — open the first one still pending — and only it knows which
 * that is.
 */
export function parseOnboardingStep(value: string | undefined): OnboardingStepId | undefined {
  return ONBOARDING_STEP_IDS.find((id) => id === value);
}
