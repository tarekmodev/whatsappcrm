import type {
  DeploymentEnvironment,
  LifecycleActorType,
  LifecycleTrigger,
  TenantStatus,
  WebhookEventStatus,
} from './content-types';

/**
 * The operator console's content layer. Every user-facing string in `apps/admin`
 * comes from here, so no component contains literal copy and a locale can be
 * added by shipping a second module with the same shape (`typeof content`).
 *
 * ## Its own module, not `apps/web`'s
 *
 * The shared primitives this app consumes — `Button`, `Modal`, `FormError` —
 * still read `apps/web`'s content for their own generic strings ("Cancel", "Try
 * again", "Saving…"), and that is correct: those are the component's words, not
 * a product's. This module holds what is *this app's*, and it is separate for
 * the reason `docs/STYLE.md` fixes three readers: everything here is written for
 * the **platform operator**, somebody who runs the platform, reads a terminal,
 * and does not work inside any tenant.
 *
 * So it says *tenant* where the tenant console says *workspace*, it names
 * statuses with the contract's own vocabulary rather than the softened wording
 * `apps/web` shows a customer, and it is allowed to name an environment variable,
 * a table or an event id — none of which may appear in copy a tenant user reads.
 *
 * Copy marked "(spec)" is verbatim from `docs/design/0002-reqta-alignment-spec.md`
 * Part 2. Changing one of those is a change to the spec first.
 */
export const content = {
  /**
   * The locale this module is written in, for `Intl` formatters that phrase a
   * value rather than translate it.
   */
  locale: 'en-GB',

  app: {
    name: 'Platform admin',
    description: 'Operator console for the WhatsApp CRM platform.',
    skipToContent: 'Skip to main content',
  },

  nav: {
    label: 'Operator sections',
    tenants: 'Tenants',
    domains: 'Domains',
    webhooks: 'Webhooks',
  },

  /**
   * The bar's environment marker (spec §2.1). The one thing this console has
   * that the tenant console does not, and it earns its place: every write here
   * is cross-tenant and irreversible, and "which environment am I in" is the
   * question behind every operator incident.
   */
  deployment: {
    label: 'Deployment',
    names: {
      production: 'Production',
      staging: 'Staging',
      development: 'Development',
    } satisfies Record<DeploymentEnvironment, string>,
  },

  // --- The credential -------------------------------------------------------
  credential: {
    /**
     * The **page's** name, not the product's. The brand panel beside it carries
     * the product; the lockup above the form carries it once more for a screen
     * reader. Three spellings of one identity on one screen is what a lockup
     * exists to stop, so this slot says what the screen is for instead.
     */
    title: 'Operator credential',
    /**
     * The brand panel's one line. It says what the surface is rather than
     * selling it — an operator console has no audience to persuade, and the
     * tenant console's tagline would be marketing on a control plane.
     */
    brandStatement:
      'Cross-tenant operations: provisioning, lifecycle, custom domains and parked webhook events.',
    /**
     * (spec) The only place an operator learns that `actorLabel` on the audit
     * trail is a credential and not them.
     */
    intro:
      'This console is authenticated by a shared operator credential, not a personal account. Every action you take is recorded against the credential’s label.',
    tokenLabel: 'Operator token',
    tokenRequiredError: 'Enter an operator token',
    submit: 'Continue',
    pending: 'Checking…',
    /**
     * (spec) One sentence for every failure mode. The guard never distinguishes
     * "no token configured" from "wrong token", deliberately, and neither does
     * this screen.
     */
    refused: 'That credential was refused.',
    /** The bar's control, and the reason it exists (spec §2.2). */
    forget: 'Forget credential',
    forgottenToast: 'Credential forgotten',
    /**
     * (spec) Shown when the API refuses a credential the console was already
     * holding — the token was rotated underneath an operator. Never a silent
     * redirect: somebody mid-incident needs to know the credential changed.
     */
    refusedMidSessionTitle: 'This credential is no longer accepted',
    refusedMidSessionBody:
      'The platform admin token was changed or revoked while this console was open. Present the current one to carry on.',
    refusedMidSessionAction: 'Present a credential',
    /**
     * Not a spec state: the console cannot run against the fixture transport at
     * all, so it refuses before the form rather than per screen.
     */
    mockApiTitle: 'Not available against mock data',
    mockApiBody:
      'This console talks to /api/v1/admin/* with a platform admin token, and the fixture transport has no such surface. Set NEXT_PUBLIC_USE_MOCK_API=false and point API_BASE_URL at a running API to use it.',
  },

  // --- Tenants --------------------------------------------------------------
  tenants: {
    title: 'Tenants',
    lookupHeading: 'Open a tenant',
    /**
     * (spec) "That sentence is the honest version of the gap, and it is
     * deliberately in the product, not only in this document. An operator who
     * does not know the list is missing will read the screen as broken."
     */
    lookupDescription:
      'This console addresses tenants by slug. There is no cross-tenant tenant list yet — see the domain queue below for tenants with a domain in flight.',
    slugLabel: 'Tenant slug',
    slugPlaceholder: 'northwind',
    slugInvalidError: 'Use lowercase letters, digits and hyphens, 3 to 40 characters',
    open: 'Open tenant',
    opening: 'Opening…',
    provision: 'Provision a tenant',
    /** (spec) The slug is quoted back, so an operator can see their own typo. */
    notFoundTitle: (slug: string) => `No tenant has the slug ${slug}`,
    notFoundBody: 'A slug is fixed when the tenant is provisioned, and cannot be changed later.',
    backToTenants: 'Back to tenants',
  },

  // --- The domain queue -----------------------------------------------------
  domains: {
    title: 'Domains',
    queueHeading: 'Domain queue',
    loading: 'Loading the domain queue',
    caption: 'Custom domains awaiting activation',
    filterLabel: 'Queue',
    statuses: {
      verified: 'Waiting to attach',
      live: 'Attached',
    } satisfies Record<'verified' | 'live', string>,
    /** (spec) The count is the page's, never a total. */
    count: (total: number) => (total === 1 ? '1 domain' : `${total} domains`),
    columns: {
      tenant: 'Tenant',
      hostname: 'Hostname',
      verified: 'Verified',
      status: 'Status',
      actions: 'Actions',
    },
    attach: 'Attach',
    detach: 'Detach',
    attachAria: (hostname: string) => `Attach ${hostname}`,
    detachAria: (hostname: string) => `Detach ${hostname}`,
    attachedToast: (hostname: string) => `${hostname} marked attached`,
    detachedToast: (hostname: string) => `${hostname} marked detached`,
    /**
     * The row's button records that a hostname is live at the edge; it does not
     * put it there. Attaching it and issuing its certificate is a step outside
     * this console (TAR-416).
     *
     * Reworded rather than dropped, and the *notice* is the half that moved: it
     * used to read "Attaching a hostname … happens there", directly above a
     * button labelled `Attach`, so the two argued. `Attach`/`Detach` are the
     * spec's own column labels (§2.3), so the sentence gives way — it now says
     * what the button *records*, which is the thing that was ambiguous.
     */
    recordOnlyNotice:
      'Marking a domain attached records that it is already live at the edge. Adding the hostname to the web service and issuing its certificate happens in the hosting dashboard — see the custom-domains runbook.',
    /** (spec) The failure names the hostname, because the row may no longer be there. */
    actionFailed: (hostname: string) => `Could not update ${hostname}.`,
    emptyWaitingTitle: 'No domains are waiting',
    emptyWaitingBody: 'A tenant’s custom domain appears here once they have proved they own it.',
    /** (spec) A *different* state from the above — sharing one makes a filter look broken. */
    emptyLiveTitle: 'Nothing is attached yet',
    emptyLiveBody: 'No verified domain has been marked attached on this deployment.',
    emptyLiveAction: 'Show what is waiting',
  },

  // --- One tenant -----------------------------------------------------------
  tenant: {
    loading: 'Loading tenant',
    /*
     * The `<h1>` is the **slug**, drawn as the identifier it is, and there is no
     * subtitle at all.
     *
     * §2.4 puts the tenant's *name* in the heading with the slug beneath it. No
     * read on the admin surface returns a name — `AdminTenantLifecycleEvent`
     * carries none, and only the writes do — so the slug takes the heading and
     * the slot beneath it stays **empty**. A sentence describing the page to
     * somebody already standing on it is not what that slot is for; the name
     * goes there when a tenant read lands.
     */
    manage: 'Manage tenant',

    /** Names the status band for assistive technology; the chip carries the value. */
    bandLabel: 'Lifecycle status',
    /**
     * The Lifecycle card's two terms. Its own pair rather than the trail table's
     * column headers: a `<dt>` names one tenant's current value ("Status"),
     * while a `<th>` names a column of them ("Change"), and reusing one for the
     * other reads as a mislabelled row.
     */
    statusLabel: 'Status',
    lastChangedLabel: 'Last changed',
    statusUnknown: 'Not recorded',
    statusUnknownHint:
      'This tenant has no lifecycle rows, so its current status cannot be read from this surface.',

    lifecycleHeading: 'Lifecycle',
    /**
     * Every date `AdminTenantLifecycleResponse` carries. **A null date renders no
     * row** — a list of "—" is a screen of absences (spec §2.4).
     *
     * These are only known after a write in this session returns them; the trail
     * carries no dates. Said on screen rather than left as an empty card.
     */
    lifecycleUnknown:
      'The admin API has no tenant read, so these dates are known only after a write in this session returns them.',
    /**
     * (spec) Above the header on a purged tenant. Every write is omitted rather
     * than disabled — the graph forbids every edge out of `deleted` — and this is
     * what says *why*, instead of leaving a screen with a neutral chip and a
     * silently absent menu.
     *
     * The date is dropped when `purgeAt` is unknown, which is the ordinary case:
     * the dates live on a write response this console may not have made. The
     * sentence still lands without it.
     */
    purgedBannerHeading: 'This tenant’s data was purged',
    purgedBannerBody: (when: string | null) =>
      when === null
        ? 'Nothing here can be undone.'
        : `It was purged on ${when}. Nothing here can be undone.`,

    historyHeading: 'History',
    historyCaption: 'Tenant lifecycle events',
    /** (spec) "25+ events" where a cursor is outstanding, "6 events" where not. */
    historyCount: (loaded: number, hasMore: boolean) =>
      `${loaded}${hasMore ? '+' : ''} ${loaded === 1 && !hasMore ? 'event' : 'events'}`,
    loadOlder: 'Load older',
    backToNewest: 'Back to newest',
    historyEmptyTitle: 'No history recorded',
    /**
     * (spec) Cannot happen — provisioning writes the first row inside the
     * transaction that creates the tenant. Rendered anyway: an impossible state
     * that renders nothing is a blank card nobody can diagnose.
     */
    historyEmptyBody:
      'Provisioning writes the first row, so an empty trail means this tenant predates the lifecycle table.',
    columns: {
      when: 'When',
      change: 'Change',
      trigger: 'Trigger',
      actor: 'Actor',
      reason: 'Reason',
    },
    /** `fromStatus` null renders the word, not an empty chip (spec §2.7). */
    createdFrom: 'Created',
    /** `unattributed` is what the backfill wrote for pre-existing tenants. */
    backfilled: 'Backfilled',
    occurredAtLabel: 'Recorded',
  },

  /*
   * Impersonation has no copy here at all, and that is the point.
   *
   * §2.10: nothing in this app renders an impersonate control, disabled or
   * otherwise — a disabled control is still a promise, and this one is a promise
   * about crossing a tenant boundary. A *notice* is not a control, but it was
   * a second stacked quiet `Notice` inside the Lifecycle card, which is about
   * status and dates; two info notices in one card is where a reader stops
   * reading either.
   *
   * The note AC 8 asks for lives in `docs/reference/platform-admin-console.md`
   * under "Deliberately not built", where the reader who needs it — somebody
   * wondering why the reference shows a control this console does not — is
   * actually looking.
   */

  // --- The writes -----------------------------------------------------------
  writes: {
    reasonLabel: 'Reason',
    /** (spec) The second sentence is load-bearing — ADR 0009 makes it a security property. */
    reasonHint: 'Recorded on the audit trail. Never shown to the tenant.',

    provisionTitle: 'Provision a tenant',
    provisionSubmit: 'Provision tenant',
    provisionPending: 'Provisioning…',
    provisionSlugLabel: 'Slug',
    provisionSlugHint: (slug: string) =>
      `This becomes the tenant’s address: ${slug || 'acme'}.example.com. It cannot be changed later.`,
    provisionNameLabel: 'Name',
    provisionNameRequired: 'Enter a name',
    provisionedToast: (name: string) => `Provisioned ${name}`,
    /** (spec) `200` is not a success — nothing changed, and the operator must know. */
    provisionExistsNotice: 'A tenant already exists at that slug. Nothing changed.',
    provisionExistsLink: 'Open it',

    suspendTitle: 'Suspend tenant',
    suspendBody: (name: string) =>
      `Suspend ${name}? Its agents lose access on their next request, including open sessions. Its data is kept.`,
    suspendSubmit: 'Suspend tenant',
    suspendPending: 'Suspending…',
    suspendedToast: (name: string) => `Suspended ${name}`,

    reactivateTitle: 'Reactivate tenant',
    reactivateBody: (name: string) => `Restore access for ${name}?`,
    reactivateSubmit: 'Reactivate tenant',
    reactivatePending: 'Reactivating…',
    reactivatedToast: (name: string) => `Reactivated ${name}`,

    cancelTitle: 'Cancel subscription',
    cancelBody: (name: string) =>
      `Cancel ${name}’s subscription? It keeps access until the grace period ends, then suspends.`,
    cancelSubmit: 'Cancel subscription',
    cancelPending: 'Cancelling…',
    cancelledToast: (name: string) => `Cancelled ${name}’s subscription`,

    deleteTitle: 'Delete tenant',
    deleteModeLabel: 'How',
    deleteScheduled: 'Schedule deletion',
    deleteScheduledHint:
      'Cancels with a grace period, then suspends, then purges on the retention clock.',
    deleteImmediate: 'Delete immediately',
    deleteImmediateHint:
      'Suspends now and moves the purge clock to now. The next sweep destroys the data.',
    deleteScheduledSubmit: 'Schedule deletion',
    deleteImmediateSubmit: 'Delete tenant now',
    deletePending: 'Deleting…',
    /** (spec) The consequence, with its date. */
    deleteImmediateWarning: (name: string) =>
      `${name}’s data will be destroyed on the next sweep. This cannot be undone.`,
    /**
     * (spec) The only type-to-confirm in the product, and justified: the one
     * action that destroys customer data on a clock the operator just shortened.
     */
    deleteConfirmLabel: 'Type the tenant’s slug to confirm',
    deleteConfirmMismatch: 'That does not match the slug',
    deletedToast: (name: string) => `Deletion scheduled for ${name}`,
    deletedNowToast: (name: string) => `${name} is suspended and queued for purge`,

    /**
     * (spec) A `409` means the transition is illegal for the tenant's current
     * state. The message names it rather than rendering the API's raw sentence.
     */
    illegalTransition: (name: string, status: string) =>
      `${name} is ${status}; that change is not allowed from here.`,
    /** (spec) The tenant went away underneath the dialog. */
    vanished: 'That tenant no longer exists. The screen has been refreshed.',
  },

  // --- Webhook replay -------------------------------------------------------
  webhooks: {
    title: 'Webhooks',
    replayHeading: 'Replay a parked event',
    /** (spec) Names the runbook, because a console with no list is otherwise a dead end. */
    replayDescription:
      'Reset a parked inbound event so the next sweep reprocesses it. Find the event id with the query in the webhooks runbook — this console has no event list.',
    runbookLink: 'Webhooks runbook',
    runbookHref:
      'https://github.com/tarekmodev/whatsappcrm/blob/main/docs/runbooks/environments.md',
    idLabel: 'Webhook event id',
    idHint:
      "From webhook_events — SELECT id, last_error FROM webhook_events WHERE status = 'failed'.",
    idRequiredError: 'Enter a webhook event id',
    idInvalidError: 'That is not a valid event id',
    submit: 'Replay event',
    pending: 'Replaying…',
    /**
     * (spec) "The copy must not overclaim" — the API is explicit that
     * `replayedAt` is when the reset committed, not when it was reprocessed.
     */
    replayedNotice: 'Reset for reprocessing. The sweeper collects it within its next interval.',
    /**
     * (spec §2.9) The API's `404` and `409` are **`Field` errors**, not a
     * form-level one: the operator is working a batch and the thing that is wrong
     * is the id they just typed, so the message belongs beside the value it is
     * about. `notFoundError` replaces the API's sentence for the one case where
     * ours is no worse; the `409` is shown verbatim, because it names the status
     * the event is really in and nothing this console could compose beats that.
     */
    notFoundError: 'No stored webhook event has that id.',
    logEmptyTitle: 'Nothing replayed yet',

    /**
     * (spec) An in-memory log of this tab's replays. An operator working a batch
     * of ids needs to see what they have already done, and with no list endpoint
     * this is the cheapest honest way to give it to them.
     */
    logHeading: 'This session',
    logNotSaved: 'This list is not saved.',
    logEmpty: 'Replays you make in this tab appear here.',
    resultId: 'Event',
    resultProvider: 'Provider',
    resultParkedError: 'Was parked with',
    resultReplayedAt: 'Reset at',
    resultNoParkedError: 'No error recorded',
    /** (spec) Only the WhatsApp sweeper runs today; the UI must not hide it. */
    providerNotSweptNotice:
      'Only WhatsApp events are swept today. This one is reset and will wait.',
  },

  // --- Shared vocabulary ----------------------------------------------------
  /**
   * The status tone map's labels (spec §2.4). Fixed once, read from one module,
   * never inline in a cell — `tenant-presentation.ts` holds the tones.
   */
  tenantStatuses: {
    created: 'Provisioning',
    trialing: 'Trialing',
    active: 'Active',
    past_due: 'Past due',
    suspended: 'Suspended',
    cancelled: 'Cancelled',
    deleted: 'Deleted',
  } satisfies Record<TenantStatus, string>,

  lifecycleTriggers: {
    user_action: 'Tenant admin',
    operator_action: 'Operator',
    billing_event: 'Billing event',
    timer: 'Timer',
    system: 'System',
  } satisfies Record<LifecycleTrigger, string>,

  lifecycleActors: {
    user: 'Tenant user',
    platform_operator: 'Platform operator',
    system: 'System',
    unattributed: 'Backfilled',
  } satisfies Record<LifecycleActorType, string>,

  webhookStatuses: {
    received: 'Received',
    processing: 'Processing',
    processed: 'Processed',
    failed: 'Failed',
  } satisfies Record<WebhookEventStatus, string>,

  errors: {
    /**
     * Appended to a message the API supplied a request id with. A field error
     * has no slot of its own for one, and losing it would take away the thing
     * that ties an operator's report to a log line.
     */
    withReference: (message: string, requestId: string) =>
      message + ' Reference ' + requestId + '.',
    heading: 'Something went wrong',
    body: 'We could not load that. Try again in a moment.',
    retry: 'Try again',
  },
} as const;

export type Content = typeof content;
