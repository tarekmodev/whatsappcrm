import {
  ADMIN_DOMAIN_QUERY_STATUSES,
  CONVERSATION_SORT_DEFAULT,
  ONBOARDING_STEP_IDS,
  type AdminDomainStatus,
  type ConversationListQuery,
  type ConversationSort,
  type KnowledgeDocumentStatus,
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
   * Plans, usage against them, and the way out to the provider's customer portal
   * (TAR-37, TAR-619).
   *
   * `checkout` rides in the URL because it is not console state at all — it is
   * where the *provider* sends the browser back to. `successPath` and
   * `cancelPath` are what `CheckoutRequestSchema` accepts, the API composes them
   * against the tenant's own origin, and the value it carries has to survive a
   * full page load from a third-party host. There is nowhere else it could live.
   *
   * Separate from `settingsWorkspace`, which shows the same seat meter: that page
   * is the workspace's *profile* and is gated on `tenant:settings` /
   * `branding:write`, while this one spends money and is gated on `billing:read`
   * / `billing:manage`. Merging them would mean one of the two audiences is
   * refused the whole page.
   */
  settingsBilling: (query?: BillingQuery) =>
    withQuery('/settings/billing', {
      [searchParamKeys.billingCheckout]: query?.checkout,
      [searchParamKeys.billingPlan]: query?.planKey,
    }),
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
  /**
   * The tenant's response deadlines — the SLA window every new ticket is
   * measured against (TAR-390, ADR 0006).
   *
   * `sla` rather than `response-deadlines`, and it is the on-screen word rule
   * being followed rather than broken: *SLA* is what the ticket queue's column
   * and its Overdue filter are already labelled, so a customer reading this path
   * is reading a word the console says to them. The page's own heading spells it
   * out for anyone who has not met the acronym.
   *
   * No query parameters. The surface is one card holding the tenant's single
   * catch-all policy; there is no filter or selection anybody would share.
   */
  settingsSla: () => '/settings/sla',
  settingsWhatsApp: () => '/settings/whatsapp',
  /** Logo, favicon and the two brand colours (TAR-29). */
  settingsBranding: () => '/settings/branding',
  /**
   * The tenant's own hostnames (TAR-29). Separate from branding because the two
   * are different authorities — `domain:write` controls DNS and therefore every
   * invite and reset link, `branding:write` controls a colour.
   */
  settingsDomains: () => '/settings/domains',
  /**
   * The AI chatbot: its knowledge base and the settings that decide when it
   * answers (TAR-28).
   *
   * `chatbot`, not `ai`. The path is read by a customer, and `docs/STYLE.md`
   * reserves *agent* for a person — so the on-screen word for the machine is
   * "chatbot", and the URL takes the on-screen word.
   *
   * The knowledge base's title search and status filter ride in the URL
   * (TAR-613). The table holds one page of ten and a tenant may have more, so
   * the two filters are the only way to reach the rest — and "everything that
   * failed to index" is a link an admin sends rather than a sequence of clicks
   * they describe.
   *
   * No `cursor`: this surface ships no pager, so there is no page to reproduce.
   */
  settingsChatbot: (query?: ChatbotQuery) =>
    withQuery('/settings/chatbot', chatbotSearchParams(query)),
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
  /**
   * Public self-signup: the form a visitor with no account and no tenant fills in
   * (TAR-36, TAR-405, ADR 0009 decision 3).
   *
   * **Served on the platform host only**, and that is not a deployment detail
   * this file can enforce — it is what the surface *is*. There is no tenant to
   * resolve until `verifySignup` runs, so a tenant's own white-labelled hosts
   * have nothing to offer here and the console never links to it from a
   * tenant-facing screen.
   *
   * No query parameters. Nothing about the form is shareable: a pre-filled slug
   * in a link would be a name somebody else picked, and the address it is for is
   * typed by the person at the keyboard.
   */
  signup: () => '/signup',
  /**
   * The target of the signup verification email. The path is fixed by the API's
   * `VERIFY_LINK_PATH` (`apps/api/src/signup/tenant-signup.service.ts`), which is
   * what the mailer puts in front of `#token=…`; `routes.test.ts` pins the
   * spelling so the two cannot drift into a dead link, exactly as it does for
   * `resetPassword`.
   *
   * `verifySignup` here and `/verify` in the URL: the path is read by somebody
   * who has just been told to check their email and knows what they are
   * verifying, while this map holds three other kinds of link and needs to say
   * which one it is.
   */
  verifySignup: () => '/verify',
  forgotPassword: () => '/forgot-password',
  /**
   * The target of the link in a password-reset email. The path is fixed by the
   * API's `RESET_PASSWORD_LINK_PATH` (`apps/api/src/identity/mailer/mailer.port.ts`),
   * which is what the mailer puts in front of `#token=…`; `routes.test.ts` pins
   * the spelling so the two cannot drift into a dead link.
   */
  resetPassword: () => '/reset-password',
  forbidden: () => '/forbidden',

  /**
   * The platform-operator console (TAR-804). Everything below `/admin` is *ours*
   * — the surface `apps/api`'s `/api/v1/admin/*` controllers answer — and it is
   * not reachable by a tenant's own users at any role.
   *
   * A path segment rather than a route group, unlike `(app)` and `(auth)`: the
   * prefix is load-bearing. `proxy.ts` decides which of the two credentials a
   * request is missing by reading it, and the platform-admin cookie is scoped to
   * it so the operator's token is never sent on a call to a tenant's API.
   */
  adminSignIn: (query?: LoginQuery) =>
    withQuery('/admin/sign-in', { [searchParamKeys.redirectTo]: query?.redirectTo }),
  /**
   * Where an operator arrives. Tenants rather than a dashboard, because a
   * dashboard would need cross-tenant aggregates the admin API does not expose —
   * see `lib/api/admin.ts` for the endpoints that exist and the reads that do not.
   */
  adminTenants: () => '/admin/tenants',
  /**
   * One tenant: its lifecycle state, its trail, and the two operator actions.
   *
   * Encoded, unlike the id-keyed routes above. A slug is *typed by an operator*
   * into the lookup form, so this is the one route in the map whose parameter is
   * not already known to be URL-safe.
   */
  adminTenant: (slug: string, query?: AdminTenantQuery) =>
    withQuery(`/admin/tenants/${encodeURIComponent(slug)}`, {
      [searchParamKeys.adminTrailCursor]: query?.cursor,
    }),
  /** The operator's custom-domain queue — `GET /v1/admin/domains` (TAR-419). */
  adminDomains: (query?: AdminDomainsQuery) =>
    withQuery('/admin/domains', { [searchParamKeys.adminDomainStatus]: query?.status }),
  /** Replaying a parked inbound webhook event — TAR-94's one route. */
  adminWebhookEvents: () => '/admin/webhook-events',
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
   * The list column's order (TAR-517). Spelled as `ConversationListQuerySchema`
   * names it, and omitted from the URL while it is the default — a `?sort=newest`
   * on every filter link would be a parameter that never says anything.
   *
   * Unlike the ticket queue, whose order is the API's alone (see `tickets`
   * above), the inbox has two honest readings of the same column and the agent
   * picks: what has just arrived, or what nobody has touched for longest.
   */
  inboxSort: 'sort',
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
  /**
   * The per-agent breakdown's order (TAR-519). Two parameters rather than one
   * packed value, so a shared link reads as what it is — `?sort=resolution&dir=desc`
   * — and each narrows against its own small enum. Both are dropped while the
   * table is in the API's own order, which is what keeps the default view's URL
   * to the dates it is about.
   */
  reportSort: 'sort',
  reportSortDirection: 'dir',
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
   * The knowledge base table's two filters (TAR-613). Spelled exactly as
   * `KnowledgeDocumentListQuerySchema` names them, so a URL parameter and the
   * query it becomes cannot drift — the rule `ticketStatus` already follows.
   *
   * `q` is a title match, not a content search: the contract documents it as
   * "a plain case-insensitive match over `title` — a console filter, not the
   * retrieval path", and the search box says so on screen.
   */
  knowledgeQuery: 'q',
  knowledgeStatus: 'status',
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
  /**
   * How the hosted checkout page sent the browser back. `checkout`, not
   * `checkoutOutcome`: it is read by a person in a URL bar, and the two values
   * it takes say the rest.
   */
  billingCheckout: 'checkout',
  /**
   * Which plan the checkout that is coming back was *for*.
   *
   * Load-bearing rather than decorative: without it, "the subscription is
   * active" cannot tell a completed upgrade from the plan the tenant was already
   * on, and the page would congratulate somebody on a change that has not landed
   * yet. With it, "active **and** on this plan" is the only thing that counts as
   * confirmed.
   */
  billingPlan: 'plan',
  /** Where sign-in sends the user afterwards. Read through `parseRedirectPath`. */
  redirectTo: 'next',
  /**
   * Which half of the operator's domain queue is shown — `verified` (waiting to
   * be attached at the edge) or `live` (already attached). Spelled exactly as
   * `AdminDomainQuerySchema` names it, so the URL parameter and the query it
   * becomes cannot drift; dropped while it is the API's own default, which is
   * `verified`.
   */
  adminDomainStatus: 'status',
  /**
   * Which page of a tenant's lifecycle trail is shown. Spelled `cursor`, as
   * `CursorPageQuerySchema` names it.
   *
   * In the URL rather than in component state because the trail is what an
   * operator sends to somebody mid-incident, and "the page I was on" has to
   * survive the link. It is opaque and paged forward only — the API publishes no
   * previous cursor — so the way back to the newest page is the bare route,
   * which is what the pager offers.
   */
  adminTrailCursor: 'cursor',
} as const;

/**
 * How a hosted checkout ended, as the provider hands it back.
 *
 * `succeeded` is deliberately **not** "the plan is active". The redirect races
 * the subscription webhook and usually wins it, so this value says only which
 * button the user pressed on the provider's page; whether the plan actually
 * changed is read from `GET /billing/subscription` and nowhere else. A console
 * that congratulated somebody on a plan the API has not confirmed would be
 * announcing a payment it has no evidence of.
 */
export const CHECKOUT_OUTCOMES = ['succeeded', 'cancelled'] as const;
export type CheckoutOutcome = (typeof CHECKOUT_OUTCOMES)[number];

export interface BillingQuery {
  checkout?: CheckoutOutcome;
  /** The plan the checkout was for; omitted on the cancel path, which bought nothing. */
  planKey?: string;
}

/** Narrows an untrusted `?checkout=` value; anything else is no outcome at all. */
export function parseCheckoutOutcome(value: string | undefined): CheckoutOutcome | undefined {
  return CHECKOUT_OUTCOMES.find((outcome) => outcome === value);
}

export interface OnboardingQuery {
  /** Omitted means "open the first step still pending" — see `nextOnboardingStep`. */
  stepId?: OnboardingStepId;
}

export interface LoginQuery {
  redirectTo?: string;
}

/** `?cursor=` on one tenant's lifecycle trail. Omitted means the newest page. */
export interface AdminTenantQuery {
  cursor?: string;
}

/** `?status=` on the operator's domain queue. Omitted means the API's default. */
export interface AdminDomainsQuery {
  status?: AdminDomainStatus;
}

/**
 * The queue's default half, spelled the same way `AdminDomainQuerySchema`
 * defaults it. Named rather than repeated, because two places have to agree on
 * it: the tab that renders as current when the URL says nothing, and the link
 * that must *drop* the parameter rather than write one saying what the API would
 * have done anyway.
 */
export const ADMIN_DOMAIN_STATUS_DEFAULT: AdminDomainStatus = 'verified';

/** Narrows an untrusted `?status=`; anything else is the default half. */
export function parseAdminDomainStatus(value: string | undefined): AdminDomainStatus {
  return (
    ADMIN_DOMAIN_QUERY_STATUSES.find((status) => status === value) ?? ADMIN_DOMAIN_STATUS_DEFAULT
  );
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
  /**
   * The per-agent breakdown's order. Omitted together while the table is in the
   * API's own order; `agent-sort.ts` owns what the two values may be.
   */
  sort?: string;
  sortDirection?: string;
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
  /** The list column's order. The default is dropped from the URL. */
  sort?: ConversationSort;
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

export interface ChatbotQuery {
  /**
   * A title fragment, 1–120 chars. Matched against `title` only — never the
   * entry's text, which is what the chatbot itself searches.
   */
  q?: string;
  /** A `KnowledgeDocumentStatus`; omitted means every entry. */
  status?: KnowledgeDocumentStatus;
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
    // The default order is what an unparameterised arrival already gets, so
    // writing it would put `?sort=newest` on every row link and every filter
    // entry for no reader. `withQuery` drops an `undefined`.
    [searchParamKeys.inboxSort]:
      query?.sort === CONVERSATION_SORT_DEFAULT ? undefined : query?.sort,
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
    [searchParamKeys.reportSort]: query?.sort,
    // Only ever beside a column: a direction on its own says nothing.
    [searchParamKeys.reportSortDirection]:
      query?.sort === undefined ? undefined : query.sortDirection,
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

function chatbotSearchParams(query: ChatbotQuery | undefined): Record<string, string | undefined> {
  return {
    [searchParamKeys.knowledgeQuery]: query?.q,
    [searchParamKeys.knowledgeStatus]: query?.status,
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
