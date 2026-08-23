import type {
  AgentAvailability,
  AiReadinessBlocker,
  ConversationBotState,
  ConversationSort,
  ConversationStatus,
  CustomFieldType,
  DomainVerificationFailureReason,
  FallbackAssignmentReason,
  HandoffReason,
  KnowledgeDocumentStatus,
  MessageStatus,
  MessageType,
  OnboardingStepId,
  OnboardingStepStatus,
  PlanFeature,
  SlaTargetKind,
  SubscriptionStatus,
  TenantDomainKind,
  TenantDomainStatus,
  TenantRole,
  TenantStatus,
  TicketEventType,
  TicketPriority,
  TicketStatus,
  UserStatus,
  WhatsAppAccountStatus,
  WhatsAppBusinessVerificationStatus,
  WhatsAppQualityRating,
  WorkflowActionOutcome,
  WorkflowActionType,
  WorkflowAssignmentState,
  WorkflowBrokenReason,
  WorkflowConditionType,
  WorkflowFailureReason,
  WorkflowMatchOperator,
  WorkflowNotifyAudience,
  WorkflowNumberOperator,
  WorkflowRunStatus,
  WorkflowSetOperator,
  WorkflowTaxonomyKind,
  WorkflowTriggerType,
} from '@whatsappcrm/contracts';
import type { FileSizeUnit } from '@/lib/format/file-size';

/**
 * The content layer. Every user-facing string in `apps/web` comes from here, so
 * no component contains literal copy and a locale can be added by shipping a
 * second module with the same shape (`typeof content`).
 *
 * Keys describe *meaning*, not position, and interpolation is a function rather
 * than string concatenation so a translated sentence can reorder its parts.
 */
/**
 * Why the reply box is shut on a thread in the shared pool (TAR-186), hoisted
 * because two places say it: the composer's guidance line, and the internal-note
 * panel behind the composer's other tab.
 *
 * The reason is the customer's, not the reader's role — two agents looking at the
 * same unclaimed thread would both reply, and claiming is what makes one of them
 * the one answering. An object literal cannot reference its own keys, so a line
 * used twice is a const rather than a copy.
 */
const CLAIM_BEFORE_WRITING =
  'Nobody is handling this conversation yet. Claim it above to reply — that is what stops two of you answering the same customer.';

export const content = {
  /**
   * The locale this module is written in, for `Intl` formatters that phrase a
   * value rather than translate it — a list, a plural, a date. Read from here
   * rather than from the browser so server and client render the same string, and
   * so a second content module carries its own locale with its own copy.
   */
  locale: 'en-GB',

  app: {
    name: 'WhatsApp CRM',
    description: 'Multi-tenant, white-label WhatsApp CRM and helpdesk',
    skipToContent: 'Skip to main content',
  },

  nav: {
    primaryLabel: 'Primary',
    settingsLabel: 'Settings sections',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    collapseNav: 'Collapse navigation',
    expandNav: 'Expand navigation',
    inbox: 'Inbox',
    contacts: 'Contacts',
    tickets: 'Tickets',
    reports: 'Reports',
    settings: 'Settings',
    workspace: 'Workspace',
    billing: 'Plans and billing',
    customFields: 'Custom fields',
    /** `docs/STYLE.md`: *canned response* in code, *saved reply* on screen. */
    savedReplies: 'Saved replies',
    people: 'People',
    assignment: 'Assignment',
    /**
     * Spelt out rather than "SLA". The queue's column has the width for an
     * acronym and the settings tab list has the width for the words, and a
     * destination somebody visits twice a year should say what it is.
     */
    sla: 'Response deadlines',
    workflows: 'Workflows',
    chatbot: 'Chatbot',
    whatsapp: 'WhatsApp',
    branding: 'Branding',
    domains: 'Domains',
    security: 'Security',
    onboarding: 'Getting started',
    /** The rail's own expand/collapse boundary — not the drawer's open/close. */
    showMore: 'More',
    showLess: 'Less',
    moreLabel: 'More destinations',
    accountLabel: 'Account and preferences',
  },

  /**
   * The one place a channel is named. One channel exists today; the group is
   * here so the second one is a key rather than a component edit.
   */
  channels: {
    whatsapp: 'WhatsApp',
  },

  /** The top bar's workspace search. It searches conversations, and says so. */
  search: {
    label: 'Search conversations',
    /**
     * The collapsed trigger below the layout breakpoint, once a term is applied:
     * the field is behind an icon there, so the icon has to say what is behind
     * it rather than leaving an active search silent.
     */
    labelWithTerm: (term: string) => `Search conversations, showing “${term}”`,
    placeholder: 'Search conversations',
    submit: 'Search',
    clear: 'Clear search',
    /** Puts the field away again; the term it submitted stays in the URL. */
    close: 'Close search',
    resultsFor: (term: string) => `Conversations matching “${term}”`,
    /** Quotes the term back, so a search that matched nothing cannot be mistaken
        for a filter that is empty or a list that has never had anything in it. */
    emptyHeading: (term: string) => `No matches for “${term}”`,
    emptyBody: 'Try a different name, number or phrase — search covers this filter only.',
  },

  /**
   * The top bar's quick-create menu. Every entry is a link to a surface that
   * exists; an entry is added by the story that builds the thing it creates.
   */
  quickCreate: {
    label: 'Create',
    invitePerson: 'Invite a teammate',
    createTeam: 'Create a team',
    connectWhatsApp: 'Connect a WhatsApp number',
  },

  theme: {
    label: 'Theme',
    toggleToDark: 'Switch to dark theme',
    toggleToLight: 'Switch to light theme',
    /**
     * The visible label where the toggle is a labelled control rather than an
     * icon in the chrome (TAR-521). It names the theme the press *lands on*, so
     * the word on screen is a substring of the accessible name above it — which
     * is what SC 2.5.3 asks of a control whose label and name differ.
     */
    dark: 'Dark',
    light: 'Light',
  },

  roleStub: {
    label: 'Viewing as',
    hint: 'Stubbed role source — replaced by the session role once TAR-35 lands.',
  },

  roles: {
    agent: 'Agent',
    supervisor: 'Supervisor',
    admin: 'Admin',
  } satisfies Record<TenantRole, string>,

  roleDescriptions: {
    agent: 'Handles their own and their teams’ conversations.',
    supervisor: 'Sees every conversation in the tenant and manages assignment.',
    admin: 'Full tenant scope, including people and workspace settings.',
  } satisfies Record<TenantRole, string>,

  userStatuses: {
    invited: 'Invited',
    active: 'Active',
    suspended: 'Suspended',
    // A soft delete. `DELETE /users/{id}` sets it rather than dropping the row,
    // so the record of what that person did survives — it is reachable only by
    // asking for it explicitly, but it still has to have a label.
    removed: 'Removed',
  } satisfies Record<UserStatus, string>,

  availability: {
    available: 'Available',
    away: 'Away',
    offline: 'Offline',
  } satisfies Record<AgentAvailability, string>,

  conversationStatuses: {
    open: 'Open',
    pending: 'Pending',
    resolved: 'Resolved',
    closed: 'Closed',
  } satisfies Record<ConversationStatus, string>,

  ticketStatuses: {
    open: 'Open',
    /** Waiting on the customer. The customer's next message reopens it. */
    pending: 'Waiting on customer',
    resolved: 'Resolved',
    closed: 'Closed',
  } satisfies Record<TicketStatus, string>,

  ticketPriorities: {
    low: 'Low',
    normal: 'Normal',
    high: 'High',
    urgent: 'Urgent',
  } satisfies Record<TicketPriority, string>,

  /**
   * The outbound send ladder. Inbound messages are born `delivered`, so these
   * are only ever rendered on the team's own side of a thread.
   */
  messageStatuses: {
    queued: 'Queued',
    sent: 'Sent',
    delivered: 'Delivered',
    read: 'Read',
    failed: 'Not delivered',
  } satisfies Record<MessageStatus, string>,

  /**
   * What a message *is*, for the types the thread cannot render as themselves.
   * Text and the four media kinds render their own content; the rest get a
   * labelled placeholder, because a customer who sent their location deserves a
   * row saying so rather than a gap.
   */
  messageTypes: {
    text: 'Message',
    image: 'Photo',
    video: 'Video',
    audio: 'Voice message',
    document: 'Document',
    sticker: 'Sticker',
    location: 'Location',
    contacts: 'Shared contact',
    interactive: 'Interactive message',
    template: 'Template message',
    system: 'System message',
    unsupported: 'Unsupported message',
  } satisfies Record<MessageType, string>,

  fileSizeUnits: {
    bytes: 'bytes',
    kb: 'KB',
    mb: 'MB',
    gb: 'GB',
  } satisfies Record<FileSizeUnit, string>,

  common: {
    save: 'Save changes',
    cancel: 'Cancel',
    close: 'Close',
    retry: 'Try again',
    loading: 'Loading',
    optional: 'Optional',
    search: 'Search',
    dismiss: 'Dismiss',
    all: 'All',
    none: 'None',
    unassigned: 'Unassigned',
    notifications: 'Notifications',
    clearSearch: 'Clear search',

    /**
     * The overflow trigger on a table row (0001, TAR-709). Named after the row,
     * not after the verb: a column of triggers all reading "More actions" tells
     * a screen-reader user which control they are on and nothing about which
     * row.
     */
    rowActions: (subject: string) => `More actions for ${subject}`,

    // --- The filter row (0001, TAR-516) -------------------------------------
    filters: 'Filters',
    /** The trigger's badge is a bare numeral; on its own it reads as "Filters 2". */
    filtersWithCount: (count: number) =>
      count === 1 ? 'Filters, 1 applied' : `Filters, ${String(count)} applied`,
    activeFilters: 'Active filters',
    /** Names what a chip's × does; `chip` is the "Status: Resolved" text on it. */
    clearFilter: (chip: string) => `Clear ${chip}`,
    clearAllFilters: 'Clear all',
    /** A chip: the group and the value it is narrowed to. */
    filterChip: (group: string, value: string) => `${group}: ${value}`,
  },

  /**
   * `DateRangeField`'s copy. Its own group rather than a screen's, because the
   * control is shared and none of this is about reporting.
   */
  dateRange: {
    fromLabel: 'From',
    toLabel: 'To',
    presetsLabel: 'Quick ranges',
    previousMonth: 'Previous month',
    nextMonth: 'Next month',
    openCalendar: (field: string) => `Open the calendar for ${field}`,
    gridLabel: (month: string) => `${month}, choose a date`,
    apply: 'Apply',
    /** The one place a date format is spelled out, as a placeholder and a hint. */
    format: 'YYYY-MM-DD',
    /** An en dash, which is the typographic form for a span of dates. */
    displayValue: (from: string, to: string) => `${from} – ${to}`,
    /** The same span said aloud; a screen reader does not read "–" as "to". */
    spokenValue: (from: string, to: string) => `${from} to ${to}`,
    triggerName: (label: string, value: string) => `${label}: ${value}`,
    invalidDate: 'Enter both dates as YYYY-MM-DD',
  },

  errors: {
    heading: 'Something went wrong',
    body: 'We could not load this section. Retrying usually fixes it.',
    forbiddenHeading: 'You do not have access to this page',
    forbiddenBody: 'Ask a workspace admin if you need it.',
    correlationId: (requestId: string) => `Reference ${requestId}`,
    staleBundleHeading: 'A new version is available',
    staleBundleBody: 'Reload to pick up the latest version of the console.',
    reload: 'Reload',
  },

  inbox: {
    title: 'Inbox',
    conversationsHeading: 'Conversations',
    scopeLabel: 'Conversation scope',
    scopeAssigned: 'Assigned to me',
    scopeUnassigned: 'Unassigned',
    scopeAll: 'All conversations',
    statusLabel: 'Status',
    loadingConversations: 'Loading conversations',
    /**
     * Three empty states, not one (TAR-515). "Nothing has ever arrived", "this
     * filter has nothing in it" and "that search matched nothing" are different
     * answers, and the one string they used to share made a working search look
     * broken to whoever had just typed into it.
     */
    emptyHeading: 'No conversations yet',
    emptyBody:
      'Conversations appear here as customers message your WhatsApp number. Connect one to start receiving them.',
    /** Only offered to a principal holding `channel:manage`; see `ConversationList`. */
    emptyConnectAction: 'Connect a WhatsApp number',
    filteredEmptyHeading: (filterName: string) => `Nothing in ${filterName}`,
    filteredEmptyBody: 'Conversations move in and out of this filter as they are worked.',
    /**
     * A URL can name a scope and status combination the filter column has no
     * entry for — reachable by hand and from an older link — so the heading
     * cannot always name the filter.
     */
    filteredEmptyUnnamedHeading: 'Nothing matches this filter',
    /** The `all-open` entry: the widest view that is still the day’s work. */
    filteredEmptyAction: 'View all open',
    /**
     * The word beside the number in a `Badge variant="count"`. The chip shows
     * the digits and nothing else — a count is a count, not the sentence "2
     * unread" in a pill (0001, "Status vocabulary") — so this travels with it
     * invisibly and is what a screen reader hears after the number.
     */
    unreadUnit: 'unread',
    /**
     * The same fact as a phrase rather than a chip, for the row link's own
     * accessible name — the dot and the count circle are visual, and a row whose
     * name did not carry them would report unread state in colour alone.
     */
    unreadSummary: (count: number) => `${String(count)} unread`,
    assignedTo: (name: string) => `Assigned to ${name}`,
    /**
     * Somebody holds this thread and the console could not resolve who — the
     * directory read is one page. Saying "assigned" without a name is the honest
     * answer; dropping the badge would make a claimed thread look unheld.
     */
    assignedToUnresolved: 'Assigned to another agent',
    assignedToTeam: (name: string) => `Team ${name}`,
    scopeNarrowedNotice:
      'Your role sees only the conversations assigned to you or your teams, so this list is narrowed.',
    lastActivity: 'Last activity',
    contact: 'Contact',
    status: 'Status',
    assignee: 'Assignee',

    // --- Opening a thread from the list ------------------------------------
    openConversation: (name: string) => `Open the conversation with ${name}`,
    unclaimed: 'Unclaimed',
    /**
     * The row's overflow trigger. Named per conversation for the same reason
     * `claimAria` is: a column of buttons all called "More" tells a
     * screen-reader user nothing about which thread they are about to act on.
     */
    rowActions: (name: string) => `More actions for the conversation with ${name}`,

    // --- The list column's own header (TAR-517) -----------------------------
    /**
     * How many rows are on screen — not a tenant total. The list read is built
     * without a `count(*)`, so the honest number is the page's, and a page with
     * another behind it says so with `conversationCountAtLeast` rather than
     * claiming to be the whole queue.
     */
    conversationCount: (count: number) =>
      count === 1 ? '1 conversation' : `${String(count)} conversations`,
    conversationCountAtLeast: (count: number) => `${String(count)}+ conversations`,
    sortLabel: 'Sort conversations',
    /**
     * Both read the same column, `last_message_at`. "Newest first" is triage;
     * "Oldest first" is draining a queue, which is what an agent working the
     * shared pool is doing. There is no third entry — see `CONVERSATION_SORTS`
     * for why "longest waiting" is not one yet.
     */
    sorts: {
      newest: 'Newest first',
      oldest: 'Oldest first',
    } satisfies Record<ConversationSort, string>,

    // --- The chatbot, in the inbox (TAR-28) --------------------------------
    /**
     * One badge per state the bot can leave a conversation in. `off` has no
     * badge at all — a conversation the chatbot never touched is the ordinary
     * case, and labelling it would put a word on every row for no reader.
     *
     * `handed_off` is the one that earns its place: it is not "the bot is
     * answering" and it is not "nothing happened", and a list that rendered
     * those two the same would hide the conversations that need somebody now.
     */
    botStates: {
      off: '',
      bot_active: 'Bot is answering',
      handed_off: 'Bot handed over',
      human_active: 'You have taken over',
    } satisfies Record<ConversationBotState, string>,

    // --- The handoff summary ------------------------------------------------
    handoffHeading: 'What the chatbot did',
    handoffLoading: 'Loading the chatbot summary',
    handoffReasonLabel: 'Why it stopped',
    handoffReasons: {
      low_confidence: 'It was not sure enough of the answer.',
      no_match: 'It found nothing in the knowledge base about this.',
      customer_requested: 'The customer asked for a person.',
      max_turns: 'It had already replied as many times as it is allowed to.',
      agent_requested: 'Somebody on your team took the conversation.',
      bot_error: 'It could not complete the reply.',
    } satisfies Record<HandoffReason, string>,
    handoffTriggerLabel: 'The message it could not take',
    handoffRepliesLabel: 'Replies before handing over',
    handoffReplyCount: (count: number) => (count === 1 ? '1 reply' : `${count} replies`),
    handoffAtLabel: 'Handed over',
    handoffConfidenceLabel: 'How sure it was',
    /** The composite score, and the two halves it is the lower of. */
    handoffConfidenceValue: (score: string) => `${score} sure`,
    handoffConfidenceBreakdown: (model: string, retrieval: string) =>
      `Model ${model} · knowledge base ${retrieval}`,
    handoffConfidenceNone: 'It never reached the model, so there is no score.',
    /**
     * The field that catches a confidently wrong answer: the customer asked
     * about shipping and the bot answered from the refunds policy. Invisible
     * from the transcript alone, which is why it is named here.
     */
    handoffCitedLabel: 'Answered from',
    handoffCitedNone: 'It cited nothing from the knowledge base.',
    handoffExchangeLabel: 'The exchange is above, in the conversation itself.',
    handoffNone: 'The chatbot has not handed this conversation over.',

    // --- Taking a thread from the bot --------------------------------------
    takeFromBot: 'Take over from the bot',
    takeFromBotAria: (contact: string) => `Take the conversation with ${contact} from the chatbot`,
    takeFromBotSuccess: (contact: string) => `The chatbot has stopped answering ${contact}`,

    // --- Claiming ----------------------------------------------------------
    claim: 'Claim',
    claimAria: (name: string) => `Claim the conversation with ${name}`,
    claimSuccess: (name: string) => `You are handling ${name}`,
    release: 'Release',
    releaseAria: (name: string) => `Release the conversation with ${name}`,
    releaseSuccess: (name: string) => `${name} is back in the shared pool`,

    /**
     * Taking a thread off the colleague working it. A different verb from
     * "Claim" and a different confirmation, because it is a different act: the
     * shared pool is nobody's, and this one is somebody's.
     */
    takeOver: 'Take over',
    takeOverAria: (contact: string, holder: string) =>
      `Take over the conversation with ${contact} from ${holder}`,
    takeOverTitle: 'Take this conversation over?',
    /**
     * Accurate as of TAR-198: the assignment now reaches the previous holder's
     * inbox live, so the thread stops being theirs on their screen. What still
     * does not happen is a *notification* — nothing interrupts them to say so,
     * and they may be mid-reply. Hence the instruction, which is the part that
     * survived the event landing.
     */
    takeOverBody: (contact: string, holder: string) =>
      `${holder} is handling ${contact} right now. Taking it over assigns it to you and their inbox updates straight away — but nothing interrupts them to say so, and they may be part-way through a reply. Tell them yourself.`,
    takeOverConfirm: 'Take over',
    takeOverSuccess: (contact: string, holder: string) =>
      `You are handling ${contact}, taken over from ${holder}`,
    /** Stands in for a holder whose name this page could not resolve. */
    unresolvedHolder: 'Another agent',
    /** Why the note box is shut on a thread in the shared pool — see the const. */
    claimBeforeWriting: CLAIM_BEFORE_WRITING,
    /** Who holds the thread, in the header's second row. */
    assignedToLabel: 'Assigned to',
    assignedToNobody: 'Nobody yet',

    // --- The two-pane layout ------------------------------------------------
    threadHeading: 'Conversation',
    backToList: 'Back to conversations',
    /**
     * Instructional, not empty: nothing is wrong with the thread column before a
     * conversation is picked, so it is one quiet line rather than a state with a
     * title, a body and an action (TAR-515). The list beside it is the action.
     */
    noThreadHeading: 'Pick a conversation to read it and reply',
    /**
     * The API answers `not_found` for a thread the reader may not see — never
     * `forbidden`, so nothing can be enumerated. A shared supervisor link opened
     * by an agent lands here, as does a thread claimed out from under a reader.
     * Explaining it beats a generic error card with a retry that cannot work.
     */
    threadUnavailableHeading: 'This conversation is not available to you',
    threadUnavailableBody:
      'It may have been claimed by someone else, or it may be outside what your role can see. Pick another conversation from the list.',
    scopeNarrowedAllNotice:
      'You are seeing your own and your teams’ conversations plus everything nobody has claimed — not the whole workspace.',

    // --- The filter column --------------------------------------------------
    filtersHeading: 'Inbox',
    filtersLabel: 'Inbox filters',
    /** Small screens collapse the column into this disclosure above the list. */
    filtersToggle: 'Change filter',
    filterUnassigned: 'Unassigned',
    filterAssigned: 'Assigned to me',
    filterAllOpen: 'All open',
    filterAll: 'All conversations',
    filterPending: 'Pending',
    filterResolved: 'Resolved',
    filterClosed: 'Closed',
    inboxSettings: 'Inbox settings',

    // --- The thread column --------------------------------------------------
    createdAt: 'Created',
    conversationActions: 'Conversation actions',
    closeConversation: 'Close conversation',
    closeConversationTitle: 'Close this conversation?',
    closeConversationBody: (contact: string) =>
      `Closing marks the conversation with ${contact} as finished. It stays in the workspace and reopens by itself if they write in again.`,
    closeConversationConfirm: 'Close conversation',
    closeConversationSuccess: (contact: string) => `Conversation with ${contact} closed`,
    reopenConversation: 'Reopen conversation',
    reopenConversationSuccess: (contact: string) => `Conversation with ${contact} reopened`,
    /** The composer's two destinations: the customer, or the team. */
    composerTabReply: (channel: string) => `Reply on ${channel}`,
    composerTabNote: 'Comment',
    composerTabsLabel: 'Where this goes',

    // --- The context column -------------------------------------------------
    contextHeading: 'Contact',
    /** The contact's fields, as terms in a `DetailList` rather than loose lines. */
    contactPhoneLabel: 'Phone',
    contactEmailLabel: 'Email',
    contactTagsLabel: 'Tags',
    contextToggle: 'Conversation details',
    contextShow: 'Show conversation details',
    contextHide: 'Hide conversation details',
    ticketHeading: 'Ticket',
    /**
     * Tickets are opened by the auto-linking pipeline
     * (`docs/architecture/0003-ticket-auto-linking-contract.md`), not by an
     * agent pressing a button — so this panel reports the link rather than
     * offering to make one.
     */
    ticketLinkedBody:
      'It was opened automatically when the customer wrote in, and everything said here is on it.',
    /** The per-tenant number, which is what agents and customers actually quote. */
    ticketReferenceLabel: 'Reference',
    /**
     * A ticket the reader may not open. The API answers `not_found` rather than
     * `forbidden` so nothing can be enumerated, and this is that answer said in
     * words — the alternative was an empty card that read as a failed load.
     */
    ticketUnavailable:
      'A ticket is open for this conversation, and it is outside what your role can see.',
    ticketUnlinked: 'No ticket yet',
    ticketUnlinkedBody:
      'A ticket opens by itself with the customer’s next message, and this conversation joins it.',
  },

  tickets: {
    title: 'Tickets',
    subtitle: 'Work waiting on your team, urgent first.',

    // --- The queue ----------------------------------------------------------
    queueHeading: 'Ticket queue',
    queueLoading: 'Loading tickets',
    /**
     * The queue header's two halves (TAR-520): how many rows are in front of the
     * reader, and what order they are in.
     *
     * The count is the *page's*, exactly as the inbox's is — the ticket list read
     * carries no `count(*)` — so a page with a cursor behind it says "25+"
     * rather than claiming to be the whole queue.
     */
    queueCount: (count: number) => (count === 1 ? '1 ticket' : `${String(count)} tickets`),
    queueCountAtLeast: (count: number) => `${String(count)}+ tickets`,
    /**
     * Stated, not chosen. `GET /tickets` has no `sort` parameter and that is the
     * contract (ADR 0006 §6): the queue has one order, so this is a label in the
     * header rather than a menu offering a second one the API cannot serve. It
     * replaced a full sentence sitting under the card title.
     */
    queueOrderLabel: 'Sorted by',
    queueOrder: 'Urgent first, then newest',
    emptyHeading: 'Nothing waiting',
    emptyBody: 'Tickets assigned to you or your teams appear here as customers write in.',
    emptyFilteredHeading: 'Nothing matches this filter',
    emptyFilteredBody: 'Tickets move in and out of this filter as they are worked.',
    /**
     * Widens the scope to everything the principal may read and drops the
     * status, priority and overdue narrowing. Not "all tickets": the queue's
     * default status filter is the *active* queue (`open` and `pending`, ADR
     * 0006 §6), and a label promising every ticket would overclaim by two
     * statuses.
     */
    emptyFilteredAction: 'View the whole queue',
    scopeNarrowedNotice:
      'You are seeing your own and your teams’ tickets, not every ticket in the workspace.',

    columnTicket: 'Ticket',
    columnStatus: 'Status',
    columnPriority: 'Priority',
    columnAssignee: 'Assignee',
    columnOpened: 'Opened',
    columnActions: 'Actions',

    /**
     * A ticket opened by the auto-linker has no subject: the first inbound
     * message is as likely to be a photo as a sentence, so there is nothing
     * honest to derive one from. The per-tenant number is what agents and
     * customers quote anyway.
     */
    untitled: (number: number) => `Ticket #${String(number)}`,
    /**
     * The queue row's stand-in for a missing subject. `untitled` above names the
     * same ticket in a *sentence* — a toast, a dialog title, the detail heading —
     * where "Ticket #1044" is what an agent quotes. In a row the reference is
     * already on the line beneath it, so borrowing that label printed "#1044"
     * twice (TAR-520).
     */
    noSubject: 'No subject',
    reference: (number: number) => `#${String(number)}`,
    openTicket: (label: string) => `Open ${label}`,
    openedAt: 'Opened',
    updatedAt: 'Last updated',
    resolvedAt: 'Resolved',
    closedAt: 'Closed',
    /**
     * A ticket closed without being resolved keeps a null resolution time,
     * deliberately — back-filling it would manufacture a resolution that never
     * happened, and cycle-time reporting reads that column (ADR 0006 §3).
     */
    closedUnresolved: 'Closed without a resolution',

    // --- Filters ------------------------------------------------------------
    filtersLabel: 'Ticket filters',
    statusFilterLabel: 'Status',
    /** No `status` parameter at all: `open` and `pending`, the API's own default. */
    filterActive: 'Active',
    priorityFilterLabel: 'Priority',
    scopeFilterLabel: 'Scope',
    scopeAssigned: 'Assigned to me',
    scopeUnassigned: 'Unassigned',
    scopeAll: 'All tickets',

    // --- One ticket ---------------------------------------------------------
    detailLoading: 'Loading this ticket',
    detailHeading: 'Ticket',
    backToQueue: 'Back to the queue',
    conversationHeading: 'Conversation',
    openConversation: (name: string) => `Open the conversation with ${name}`,
    /**
     * The ticket exists and its conversation is not one this reader may open —
     * ticket visibility and conversation visibility are separate rules, so this
     * is reachable rather than hypothetical.
     */
    conversationUnavailable: 'The conversation behind this ticket is not visible to you.',
    noConversation: 'This ticket has no conversation behind it.',
    /**
     * The API answers `not_found` for a ticket the reader may not see, never
     * `forbidden`, so nothing can be enumerated. A shared supervisor link opened
     * by an agent lands here.
     */
    unavailableHeading: 'This ticket is not available to you',
    unavailableBody:
      'It may be outside what your role can see, or it may no longer exist. Go back to the queue and pick another.',

    // --- Changing status and priority --------------------------------------
    controlsHeading: 'Status and priority',
    statusLabel: 'Status',
    priorityLabel: 'Priority',
    /**
     * One label per transition the ticket's current status allows, named by what
     * the agent is doing rather than by the value they are setting — "Resolve"
     * is what triage feels like, "set status to resolved" is what a database
     * feels like. The set of buttons comes from `TICKET_STATUS_TRANSITIONS`, so
     * a status with no moves left renders none.
     */
    statusActions: {
      open: 'Move back to open',
      pending: 'Waiting on customer',
      resolved: 'Resolve',
      closed: 'Close',
    } satisfies Record<TicketStatus, string>,
    /**
     * `closed` is terminal: `TICKET_STATUS_TRANSITIONS` leaves it with nowhere
     * to go, so the control is replaced by the value rather than rendered as a
     * select with one option — a picker that cannot pick anything is the
     * hardest kind of control to understand.
     */
    statusFinal: 'This ticket is closed. Its status cannot change.',
    statusChangeSuccess: (label: string, status: string) => `${label} is now ${status}`,
    priorityChangeSuccess: (label: string, priority: string) =>
      `${label} is now ${priority} priority`,
    /**
     * Said rather than left as a missing control. `ticket:update` is in every
     * role's set today, so this is the rare case — a role that has had it taken
     * away — and a screen with no controls and no explanation reads as broken.
     */
    updateNotPermitted: 'Your role can read this ticket but not change it. Ask a workspace admin.',
    closeNotPermitted:
      'Your role can change this ticket’s priority but not resolve or close it. Ask a supervisor to finish it.',

    /**
     * Resolving and closing are confirmed because they are one-way at v1: there
     * is no reopen window, so neither is undoable from this screen. The copy
     * names exactly what happens rather than asking "are you sure?".
     */
    terminalConfirm: {
      resolved: {
        title: 'Resolve this ticket?',
        body: (label: string) =>
          `${label} leaves the active queue and records its resolution time. It cannot be reopened — if the customer writes again, a new ticket opens for them.`,
        confirm: 'Resolve ticket',
      },
      closed: {
        title: 'Close this ticket?',
        body: (label: string) =>
          `${label} leaves the active queue without recording a resolution time, which is how a wrong number or a spam message is filed. It cannot be reopened.`,
        confirm: 'Close ticket',
      },
    },

    /**
     * How a `status_changed` carrying `cause: 'inbound_message'` reads once the
     * event log lands (TAR-32 owns `GET /tickets/{id}/events`). The reopen
     * itself is the system's, with no actor — saying "reopened by nobody" would
     * be worse than saying who actually did it, which is the customer.
     */
    reopenedByCustomer: 'Reopened — customer replied',

    // --- Handing a ticket on, and asking for help (TAR-32, ADR 0011) --------
    /**
     * "Handoff" rather than "Assignment": this card is about giving work away
     * and asking for help, and the word an agent uses for both is a handoff.
     * The card that *places* a ticket nobody holds lives on the supervisor's
     * assignment surface and keeps its own word.
     */
    handoffHeading: 'Handoff',
    handoffDescription:
      'Hand this ticket to a teammate, or ask a supervisor to look at it. Both are recorded in its history.',
    reassign: 'Reassign',
    escalate: 'Escalate',
    /**
     * Said rather than left as two missing buttons. Both permissions are in
     * every role's set today, so this is the rare case — a role that has had
     * them taken away — and a card with no controls and no explanation reads as
     * broken.
     */
    handoffNotPermitted:
      'Your role can read this ticket but not hand it on or escalate it. Ask a workspace admin.',

    reassignTitle: (label: string) => `Reassign ${label}`,
    reassignDescription:
      'The person you pick takes it over from here. Your reason is the first thing they read in its history.',
    reassignAgentLabel: 'Hand it to',
    /**
     * Says what the list *is*, because the API bounds it: without
     * `ticket:assign` a caller may hand a ticket only to somebody they share a
     * team with, so a name missing from here is a rule rather than an oversight.
     */
    reassignAgentHint: 'People you share a team with, plus anyone your role can assign to.',
    reassignReasonLabel: 'Why you are handing it on',
    reassignReasonHint: 'The next person reads this before anything else. Say what is left to do.',
    reassignSubmit: 'Reassign ticket',
    reassignSuccess: (label: string, agentName: string) => `${label} is now with ${agentName}`,
    /**
     * The bound above, seen from inside the dialog with nobody on the other side
     * of it. An empty picker would read as a broken control; this says what is
     * missing and who can fix it.
     */
    reassignNoTeammates:
      'You share no team with anyone who could take this. Ask a supervisor to reassign it.',

    escalateTitle: (label: string) => `Escalate ${label}`,
    /**
     * The first sentence is load-bearing and is the thing agents get wrong:
     * escalating does **not** hand the ticket over. Saying so here is what stops
     * "Escalate" being read as the button that loses your work.
     */
    escalateDescription:
      'You keep this ticket. A supervisor is asked to look at it, and your reason goes on its history.',
    escalateSupervisorLabel: 'Ask someone in particular',
    escalateSupervisorHint:
      'Leave this as it is unless you need a specific person — otherwise whoever covers this ticket is asked.',
    /** The `toUserId`-absent case, named rather than rendered as a blank option. */
    escalateSupervisorAnyone: 'Whoever is covering this ticket',
    escalateReasonLabel: 'What you need decided',
    escalateReasonHint:
      'Say what is stuck and what would unblock it. Include a deadline if there is one.',
    escalateSubmit: 'Escalate ticket',
    escalateSuccess: (label: string, count: number) =>
      count === 1
        ? `${label} escalated. 1 person has been told.`
        : `${label} escalated. ${String(count)} people have been told.`,
    /**
     * `notifiedUserIds: []` is a real outcome, not a failure: a tenant with no
     * active supervisor still gets the escalation recorded (ADR 0011
     * decision 3). A green tick here would be a lie, and an error would blame an
     * agent who did nothing wrong and cannot fix it.
     */
    escalateSuccessNobody: (label: string) =>
      `${label} is recorded as escalated, but nobody in this workspace is set up to receive it. Ask a workspace admin.`,

    /**
     * Client-side because the field is required *before* submit — the form must
     * not be submittable without one (TAR-32 AC1). The API refuses the same
     * request a second time; this is the version the agent can act on without a
     * round trip.
     */
    reasonRequiredError:
      'Add a reason — it is what makes the handoff make sense to the next person.',
    reasonTooShortError: (minLength: number) =>
      `Use at least ${String(minLength)} characters, so the history says something.`,
    reasonTooLongError: (maxLength: number) => `Use at most ${String(maxLength)} characters`,

    // --- The history the two of them write ----------------------------------
    historyHeading: 'History',
    historyDescription: 'Everything that has happened to this ticket, newest first.',
    historyLoading: 'Loading this ticket’s history',
    historyEmptyHeading: 'Nothing recorded yet',
    historyEmptyBody:
      'Status changes, handoffs and escalations appear here as they happen, with who did them and why.',
    /** The API answers one page; claiming a total would mean paging the whole log. */
    historyMore: 'Older entries are not shown.',
    historyReason: 'Reason',
    historyBy: (name: string) => `by ${name}`,
    /** No actor: routing, the SLA sweep and the auto-linker write through the same column. */
    historyByAutomation: 'by the system',
    historyActorUnresolved: 'another agent',

    /**
     * One line per event type, named by what happened rather than by the column
     * that changed. `assigned` and `unassigned` are reused for reassignment
     * (ADR 0011 decision 4), so their copy has to read correctly whether or not
     * somebody held the ticket before — which is why the from/to detail is a
     * separate line rather than baked into these.
     */
    historyEvents: {
      created: 'Ticket opened',
      conversation_linked: 'A message arrived on another conversation',
      status_changed: 'Status changed',
      priority_changed: 'Priority changed',
      assigned: 'Handed on',
      unassigned: 'Released',
      escalated: 'Escalated',
      assignment_deferred: 'Auto-assignment could not place it',
      first_response: 'First reply sent',
      sla_breached: 'SLA missed',
      reopened: 'Reopened',
      bot_handoff: 'Handed over by the chatbot',
    } satisfies Record<TicketEventType, string>,

    historyValueChange: (from: string, to: string) => `${from} → ${to}`,
    historyHandedTo: (name: string) => `to ${name}`,
    historyHandedFromTo: (from: string, to: string) => `from ${from} to ${to}`,
    historyEscalatedTo: (name: string) => `to ${name}`,
    /**
     * A null `toValue` on an `escalated` event is meaningful rather than
     * missing: the escalation was addressed to whoever supervises the ticket
     * rather than to a person, and the two must not render the same.
     */
    historyEscalatedToAnyone: 'to whoever is covering this ticket',
  },

  /**
   * SLA timers and the supervisor alerts they raise (TAR-26,
   * `docs/architecture/0006-sla-timers-and-supervisor-alerts.md`).
   */
  sla: {
    // --- The indicator ------------------------------------------------------
    columnSla: 'SLA',
    firstResponse: 'First response',
    resolution: 'Resolution',
    /**
     * The state, in one word, beside the deadline it refers to. "Overdue" rather
     * than "Breached": breach is the contract's word for it and a supervisor's
     * word is late.
     */
    stateRunning: 'Due',
    statePaused: 'Paused',
    stateMet: 'Met',
    stateBreached: 'Overdue',
    /**
     * Shown where a ticket has no SLA at all — a tenant with no active policy,
     * or a timer that was cancelled with the ticket. Not an error, and not blank:
     * a stacked table row on a phone repeats its column header beside the value,
     * and an empty one reads as missing data.
     */
    notApplicable: 'No SLA',
    /** Screen-reader prefixes, so a relative time is never a bare figure. */
    firstResponseDeadline: 'First response due',
    resolutionDeadline: 'Resolution due',
    missedDeadline: 'Deadline missed',

    // --- The queue filter ---------------------------------------------------
    filterLabel: 'SLA',
    filterOverdue: 'Overdue',

    // --- The supervisor's alert bell ----------------------------------------
    alertsAria: (count: number) => `SLA alerts, ${String(count)} unacknowledged`,
    alertsNoneAria: 'SLA alerts, none unacknowledged',
    alertsLoading: 'Loading SLA alerts',
    kinds: {
      first_response: 'No first response in time',
      resolution: 'Not resolved in time',
    } satisfies Record<SlaTargetKind, string>,
    acknowledge: 'Mark seen',
    acknowledgeAria: (reference: string) => `Mark the alert for ticket ${reference} as seen`,
    acknowledgeSuccess: (reference: string) => `Alert for ticket ${reference} marked seen`,
    emptyHeading: 'Nothing is overdue',
    emptyBody: 'Tickets that miss their SLA window appear here, and your team is notified.',
    /**
     * The API answers one page. Saying "and more" rather than a total is the
     * honest version: the console would have to page the whole table to know one.
     */
    moreAlerts: 'More alerts are waiting. Open the ticket queue and filter by Overdue.',
  },

  /**
   * The supervisor's SLA settings screen (TAR-390).
   *
   * Its own group rather than more keys on `sla` above, which is the
   * ticket-facing half: a badge and an alert describe somebody else's ticket,
   * while everything here labels a control that changes the workspace. The two
   * share a feature and share no sentence.
   *
   * The screen says **deadline** and **response window**, matching
   * `docs/guides/track-overdue-tickets.md`; *breach* stays the contract's word
   * and never reaches the screen.
   */
  slaSettings: {
    title: 'Response deadlines',
    subtitle: 'The window every new ticket is measured against before it is marked overdue.',
    loading: 'Loading response deadlines',

    // --- The tenant's own window -------------------------------------------
    windowHeading: 'Response window',
    windowDescription: 'How long your team has to answer before a ticket is marked overdue.',
    /**
     * TAR-390's second acceptance criterion, on screen rather than in a release
     * note. A supervisor shortening the window needs to know before they save
     * that yesterday's tickets are not about to turn red.
     */
    futureTicketsNotice:
      'A change applies to new tickets only. Tickets already running keep the deadline they were given.',
    /**
     * The read-only variant's explanation. `sla:read` without `sla:write` is not
     * a role today, so nobody currently sees this — it is what stops a custom
     * role that can look but not touch from meeting a form whose every submit
     * the API refuses.
     */
    readOnlyNotice: 'Your role can see these settings but not change them.',
    /**
     * A workspace with no catch-all policy. Rare and real: the two writers that
     * seed one are both guarded on "no policy at all", so a workspace holding
     * only per-priority rows has none. Names who can fix it rather than leaving
     * a blank card.
     */
    noPolicyHeading: 'This workspace has no default response window',
    noPolicyBody:
      'New tickets get no deadline unless a priority override covers them. Ask whoever operates the platform to add one.',

    activeLabel: 'Give new tickets a deadline',
    activeHint:
      'Switch this off and new tickets show No SLA instead. Deadlines already running are left alone, and no new alerts are raised.',
    activeOn: 'On',
    activeOff: 'Off',
    /**
     * The read-only variant's three rows read as facts rather than as controls,
     * so the switch's imperative label and its `On` / `Off` state become a term
     * and a sentence. `sla.firstResponse` and `sla.resolution` serve as the
     * other two terms — the queue's badge already names those targets, and one
     * feature saying "First response" on one screen and "First reply" on
     * another is two features to the reader.
     */
    activeTerm: 'Deadlines',
    activeYes: 'On — new tickets get a deadline',
    activeNo: 'Off — new tickets show No SLA',
    standardLabel: 'Standard setting',
    standardHint: 'What the platform gives a workspace that has not changed it.',

    /**
     * The unit is in the label rather than beside the control, following
     * `workflows.ageMinutesLabel`: a unit that lives in the label is read out
     * with the field, where one painted next to the box is decoration a screen
     * reader may never reach.
     */
    firstResponseLabel: 'First response, in minutes',
    /**
     * Names the platform's own setting, so "the current default response window"
     * is on screen whether or not this workspace has changed it. `standard`
     * rather than `default`, which the console already uses for the name of the
     * policy row.
     */
    firstResponseHint: (standard: string) =>
      `How long until a first reply is due, counted from the customer’s message. Only a person’s reply stops the clock. The standard setting is ${standard}.`,
    resolutionLabel: 'Resolution, in minutes',
    resolutionHint:
      'How long until the ticket has to be resolved. Leave this empty for no resolution deadline, which is the standard setting.',
    /** What a window reads as when the workspace has not set one. */
    windowUnset: 'No deadline',

    save: 'Save changes',
    savedToast: 'Response deadlines updated',
    /**
     * Says what a valid answer looks like rather than what was wrong with this
     * one. An emptied number field and a half-typed one are the same value to
     * the browser, so one message has to serve both. The ceiling is thirty days
     * in minutes, read from the contract rather than restated here.
     */
    windowInvalidError: (min: number, max: number) =>
      `Enter a whole number of minutes between ${min} and ${max}, or leave it empty`,

    // --- Per-priority policies ----------------------------------------------
    /**
     * Shown only when the workspace has a policy that is not the catch-all.
     * Creating and editing those is out of TAR-390's scope — the API accepts no
     * `priority` on a write and has no create route — so they are reported
     * rather than offered as controls, which is more honest than a screen that
     * pretends they are not there.
     */
    overridesHeading: 'Priority overrides',
    overridesDescription: 'Windows that apply to one priority instead of the workspace default.',
    overridesNotice:
      'These are set through the API. This screen changes the workspace default only.',
    /** A row's value: the two windows one override sets. */
    overrideWindows: (firstResponse: string, resolution: string) =>
      `First response ${firstResponse} · Resolution ${resolution}`,
    overrideInactive: 'Not in use — tickets of this priority fall back to the workspace default.',
    overridesTruncated:
      'This workspace has more overrides than are shown here. Ask whoever operates the platform for the full list.',
  },

  thread: {
    messagesHeading: 'Messages',
    loading: 'Loading this conversation',
    emptyHeading: 'Nothing here yet',
    emptyBody: 'Messages in this conversation appear here as they arrive.',
    /** The thread opens on one page; older messages are a follow-up (TAR-20g). */
    olderMessagesNotice: (count: number) =>
      `Showing the most recent ${String(count)} messages in this conversation.`,
    /**
     * Which way a message went, said in words. The bubble's side and tint carry
     * it for a sighted reader and carry nothing at all for a screen reader, so
     * this rides on the run's sender label — once per run, not once per bubble.
     */
    inbound: 'From the customer',
    outbound: 'From your team',
    /**
     * Who a run of messages is from — the name alone, because the run's label
     * line is a name followed by a time, not a sentence. The contact's own
     * display name is used for an inbound run.
     *
     * `senderBot` is narrower than `senderAutomation` and preferred wherever the
     * message says so: both a chatbot reply (TAR-28) and a workflow reply
     * (TAR-27) are automation, and only one of them is something an agent can
     * take over from.
     */
    senderBot: 'Chatbot',
    senderAutomation: 'Automation',
    /**
     * A person sent it and this page could not resolve which one. Distinct from
     * `senderAutomation` on purpose: attributing a colleague's words to a bot is
     * a lie about the one thing this product is a record of.
     */
    senderTeammate: 'A teammate',
    sentAt: 'Sent',
    failureReason: (reason: string) => `Not delivered: ${reason}`,

    // --- Delivery, and the one state that needs acting on -------------------
    /**
     * The icon beside a delivery state is decorative; the word beside it is what
     * says which state it is. This names the pair for a screen reader so the
     * bubble reads "Delivered" rather than "image Delivered".
     */
    deliveryState: (label: string) => `Delivery: ${label}`,
    retrySend: 'Try again',
    retrySendAria: (contact: string) => `Send this message to ${contact} again`,
    retrySendSuccess: 'Message sent',
    /**
     * A failed send this console cannot rebuild. WhatsApp carries one media
     * object per message and a send names the upload's own id, which a delivered
     * message does not publish — so a failed photo is re-sent by attaching it
     * again, not by a button that would send the caption on its own.
     */
    retryUnavailable: 'Attach the file again in the reply box below to send this.',

    // --- Following a live thread --------------------------------------------
    /**
     * Offered instead of yanking the viewport: an agent who has scrolled up to
     * read something is reading it, and a thread that jumps under them is the
     * behaviour this pill exists to replace.
     */
    newMessages: (count: number) =>
      count === 1 ? '1 new message' : `${String(count)} new messages`,
    jumpToLatest: 'Jump to the newest message',
    /**
     * What a screen reader hears when a message lands, once, in a region of its
     * own. The sender is named because a thread is a conversation and "you have
     * a new message" does not say which of two people just spoke.
     */
    messageArrived: (sender: string, body: string) => `${sender}: ${body}`,
    /** The date chip between two days of a thread. */
    dayLabel: (date: string) => `Messages on ${date}`,
    /** Which channel a message travelled over, on the bubble. */
    sentVia: (channel: string) => `Sent via ${channel}`,

    attachmentDownloading: 'Still downloading — it will appear here when it arrives.',
    attachmentFailed: 'This attachment could not be downloaded.',
    imageFromCustomer: 'Photo sent by the customer',
    imageFromTeam: 'Photo sent by your team',
    stickerFromCustomer: 'Sticker sent by the customer',
    stickerFromTeam: 'Sticker sent by your team',
    openDocument: (fileName: string) => `Open ${fileName}`,
    unnamedDocument: 'Document',
    fileSize: (value: string, unit: string) => `${value} ${unit}`,
    audioUnsupported: 'Your browser cannot play this voice message.',
    videoUnsupported: 'Your browser cannot play this video.',
    unrenderableBody: 'This message cannot be shown here. Open WhatsApp to see it in full.',
  },

  composer: {
    // --- The service window -------------------------------------------------
    /**
     * WhatsApp's rule, said in the console's own words rather than Meta's.
     * "24-hour window" is jargon an agent should not have to learn from a failed
     * send, so both lines name the consequence first.
     */
    windowOpenLabel: 'Free replies close',
    /**
     * The open state is one caption in the composer's toolbar, not a banner: it
     * is a countdown on a box that works, and a two-line saturated notice above
     * every reply an agent writes was most of the composer's height (TAR-518).
     * The closed state below still gets the full explanation — that is the one
     * that changes what the composer can do.
     */
    windowClosedHeading: 'This conversation is outside the 24-hour window',
    windowClosedBody:
      'WhatsApp only accepts an approved template until the customer writes again. Send one below, and their reply reopens free messaging for another 24 hours.',
    /** The moment it happens, with the agent's draft still on screen. */
    windowJustClosedToast: 'The 24-hour window closed. Send an approved template instead.',

    // --- Free-form ----------------------------------------------------------
    replyLabel: 'Reply to the customer',
    replyPlaceholder: 'Write a reply…',
    /**
     * The hint, shown only to a tenant that *has* canned responses — a `/` that
     * nothing announces is a feature nobody finds. There is no plain version any
     * more: "the customer receives this on WhatsApp" repeated the composer's own
     * `Reply on WhatsApp` tab directly above it, and the label repeated it a
     * third time (TAR-518).
     *
     * The trigger is interpolated from the contract rather than written into the
     * sentence: one character, one source, and a hint that cannot promise a key
     * the picker does not listen for.
     */
    replyHintWithShortcuts: (trigger: string) => `Type ${trigger} to insert a saved reply.`,
    send: 'Send',
    sendSuccess: 'Message sent',
    /**
     * One line per `FreeFormProblem`. The control's own `maxLength` stops the
     * over-length case at the keystroke, so that line is a backstop rather than
     * something an agent should normally meet.
     */
    problems: {
      'body-required': 'Write a message or attach a file before sending.',
      'body-too-long': 'That is longer than WhatsApp accepts. Shorten it and try again.',
      'attachment-uploading': 'Wait for the file to finish uploading.',
      'attachment-failed': 'Remove the file that could not be uploaded, or pick another.',
    },

    // --- The toolbar --------------------------------------------------------
    /**
     * Names the row of controls under the reply box for a screen reader. The
     * controls in it are icon-only, so each carries its own accessible name too.
     */
    toolbarLabel: 'Reply tools',
    expand: 'Make the reply box taller',
    collapse: 'Make the reply box shorter',
    /**
     * The reply box's own guidance line, which replaces the two full-width
     * saturated notices the thread used to stack (TAR-518). One line, sited where
     * the reply was going to be typed, and quiet — it is guidance, not an error.
     */
    guidance: {
      'send-not-permitted':
        'Your role can read this conversation but not reply to it. Ask a workspace admin.',
      'claim-not-permitted':
        'Anyone can read a conversation nobody has claimed. Your role cannot take one — ask a supervisor, and it will appear in your assigned list.',
      'claim-first': CLAIM_BEFORE_WRITING,
      'bot-answering':
        'The chatbot is answering this conversation. Take it over above to reply yourself — the chatbot stops for good once you do.',
    },

    // --- Attachments --------------------------------------------------------
    attachLabel: 'Attach a file',
    attachChange: 'Replace file',
    attachRemove: 'Remove attachment',
    attachRemoveAria: (fileName: string) => `Remove ${fileName}`,
    attachUploading: (fileName: string) => `Uploading ${fileName}…`,
    attachReady: (fileName: string) => `${fileName} ready to send`,
    attachFailed: 'That file could not be uploaded. Try again, or pick another.',
    attachUnsupportedError: 'WhatsApp does not accept that kind of file here.',
    /** `kind` comes from `messageTypes`, so it arrives already capitalised. */
    attachTooLargeError: (kind: string, value: string, unit: string) =>
      `${kind} files can be up to ${value} ${unit} on WhatsApp. Pick a smaller one.`,
    captionLabel: 'Caption',
    captionHint: 'Sent with the file. Leave it empty to send the file on its own.',

    // --- Canned responses ---------------------------------------------------
    /**
     * Names the shortcut list for screen readers; it has no visible heading,
     * because the hint above the box has already said what it is.
     */
    cannedListLabel: 'Saved replies matching what you typed',
    /**
     * Announced politely as the token narrows. The textarea points at the
     * highlighted row with `aria-activedescendant`, which says *which* one — this
     * says how many there are to arrow through.
     */
    cannedMatchCount: (count: number) =>
      count === 1 ? '1 saved reply matches' : `${String(count)} saved replies match`,

    // --- Templates ----------------------------------------------------------
    useTemplate: 'Use a template',
    templateTitle: 'Send an approved template',
    templateDescription:
      'Meta approves these in advance. Only approved templates can be sent outside the 24-hour window.',
    templateSearchLabel: 'Search templates',
    templateSearchPlaceholder: 'Template name',
    templateLoading: 'Loading templates',
    templateEmptyHeading: 'No templates to send',
    templateEmptyBody:
      'This number has no approved template yet. A workspace admin submits them to Meta for approval.',
    /**
     * Not "you have none". The endpoint drops templates whose buttons take a
     * parameter after reading each page, so a tenant with hundreds of them can
     * have several empty pages before a sendable one — and telling them they
     * have no templates would be false.
     */
    templateDeepPageHeading: 'No sendable template in the first few pages',
    templateDeepPageBody:
      'This number has a lot of approved templates and the ones you can send from here are further in. Search by name to jump to one.',
    templateNoMatchHeading: 'No template matches that name',
    templateNoMatchBody: 'Templates are matched on the start of their name. Try fewer characters.',
    templateMoreNotice: 'More templates are available — narrow the search to find one by name.',
    templateChoose: 'Choose',
    templateChooseAria: (name: string) => `Choose the ${name} template`,
    templateBack: 'Pick another template',
    /** Meta's own language tag, e.g. `en_US`. Shown because a name is unique only within one. */
    templateLanguage: (language: string) => `Language ${language}`,
    templateNoPreview: 'This template has no text body.',
    templatePreviewHeading: 'What the customer receives',
    templateSend: 'Send template',
    templateSendSuccess: (name: string) => `Template ${name} sent`,

    // --- Filling a template -------------------------------------------------
    templateVariableLabel: (position: number) => `Value ${String(position)}`,
    templateHeaderVariableLabel: (position: number) => `Heading value ${String(position)}`,
    templateHeaderMediaLabel: (format: string) => `Header ${format}`,
    templateHeaderMediaHint:
      'This template was approved with a header, so one has to be supplied with every send.',
    templateLatitudeLabel: 'Latitude',
    templateLongitudeLabel: 'Longitude',
    templatePlaceNameLabel: 'Place name',
    templatePlaceAddressLabel: 'Address',
    /**
     * One line per `TemplateDraftProblem`. The Send button stays available and
     * the reason sits beside it, rather than a disabled button that explains
     * nothing — a disabled control is the hardest kind of thing to debug from
     * the other side of a support call.
     */
    templateProblems: {
      'body-variables': 'Fill in every value before sending.',
      'header-variables': 'Fill in every heading value before sending.',
      'header-media': 'Attach the header file before sending.',
      'header-media-uploading': 'Wait for the header file to finish uploading.',
      'header-media-failed': 'The header file could not be uploaded. Remove it and pick another.',
      'header-coordinates': 'Enter a latitude and a longitude before sending.',
    },
  },

  notes: {
    heading: 'Internal notes',
    /** Repeated at the composer, because "the customer never sees this" is the
        one thing that must not depend on the reader having scrolled up. */
    privacyNotice: 'Only your team sees these. They are never sent to the customer.',
    loading: 'Loading internal notes',
    emptyHeading: 'No notes yet',
    emptyBody: 'Leave a note so whoever picks this up next knows where it stands.',
    authorUnknown: 'A teammate',
    mentioned: (names: string) => `Mentioned ${names}`,
    addLabel: 'Add an internal note',
    addPlaceholder: 'What should the next agent know?',
    addSubmit: 'Add note',
    addSuccess: 'Note added',
    bodyRequiredError: 'Write something before adding the note',
    bodyTooLongError: (maxLength: number) => `Use at most ${String(maxLength)} characters`,
  },

  /** The five types `CUSTOM_FIELD_TYPES` publishes, named for a person. */
  customFieldTypes: {
    text: 'Text',
    number: 'Number',
    boolean: 'Yes or no',
    date: 'Date',
    select: 'Choice',
  } satisfies Record<CustomFieldType, string>,

  contacts: {
    title: 'Contacts',
    subtitle: 'Everyone who has written in to this workspace.',

    listHeading: 'Contacts',
    listLoading: 'Loading contacts',
    listCountDescription: (count: number) =>
      count === 1 ? '1 contact' : `${String(count)} contacts`,
    /**
     * Replaces the count when the read was capped. Names search, because search
     * is the way through: `q` re-queries the whole workspace rather than
     * filtering this page.
     */
    showingFirst: (count: number) =>
      `Showing the first ${String(count)} contacts. Search to find someone further down the list.`,
    emptyHeading: 'No contacts yet',
    emptyBody: 'A contact is created the first time someone messages this workspace.',
    filteredEmptyHeading: 'No contacts match this filter',
    filteredEmptyBody: 'Clear the search or the tag to see everyone again.',
    clearFilters: 'Clear filters',
    filtersLabel: 'Contact filters',

    columnName: 'Name',
    columnPhone: 'Phone',
    columnEmail: 'Email',
    columnTags: 'Tags',
    columnLastContacted: 'Last contacted',
    noEmail: 'No email',
    noTags: 'No tags',
    neverContacted: 'Never',
    optedOut: 'Opted out',
    optedOutHint:
      'This contact has opted out. Outbound messages, including templates, are blocked.',

    searchLabel: 'Search contacts',
    searchPlaceholder: 'Name, phone or email',
    filterTagLabel: 'Filter by tag',
    allTags: 'All tags',
    /** The tag in the URL no longer exists, or belongs to nobody visible here. */
    unknownTagOption: 'Unknown tag',

    openProfileAria: (name: string) => `Open ${name}`,
    backToContacts: 'Back to contacts',

    profileHeading: 'Contact',
    profileLoading: 'Loading contact',
    unavailableHeading: 'That contact is not available',
    unavailableBody: 'The link may be out of date, or the contact may belong to another workspace.',

    identityHeading: 'Identity',
    identityLoading: 'Loading contact details',
    phoneTerm: 'Phone',
    phoneHint: 'The WhatsApp identity. It cannot be changed from here.',
    emailTerm: 'Email',
    waProfileNameTerm: 'WhatsApp profile name',
    lastContactedTerm: 'Last contacted',
    createdTerm: 'First seen',

    tagsHeading: 'Tags',
    tagsLoading: 'Loading tags',
    tagsDescription: 'Tags are shared across the workspace and drive routing rules.',
    tagsFieldLabel: 'Tags on this contact',
    tagsEmptyLabel: 'No tags have been created in this workspace yet.',
    tagsUnknownHint: 'No longer available in this workspace',
    /**
     * The same row when the vocabulary read was capped. The tag is almost
     * certainly fine — it just sorted past the first 100 — and claiming it was
     * removed would be a lie about a tag in daily use.
     */
    tagsBeyondVocabularyHint: 'Not in the first 100 tags in this workspace',
    /** Says the filter itself is short, so an absent tag is not read as deleted. */
    tagFilterTruncatedHint: 'Showing the first 100 tags. Not every tag is listed.',
    saveTags: 'Save tags',
    tagsSaved: (name: string) => `Tags updated for ${name}`,

    customFieldsHeading: 'Custom fields',
    customFieldsLoading: 'Loading custom fields',
    customFieldsDescription: 'Defined by an admin under Settings, and shared by every contact.',
    customFieldsEmptyHeading: 'No custom fields yet',
    customFieldsEmptyBody:
      'An admin can define fields such as “Plan tier” or “Account manager” under Settings.',
    customFieldsEmptyAction: 'Define a custom field',
    /** Shown to a role that cannot reach the definition screen. */
    customFieldsEmptyBodyReadOnly:
      'Ask a workspace admin to define the fields your team needs on a contact.',
    saveCustomFields: 'Save fields',
    customFieldsSaved: (name: string) => `Custom fields updated for ${name}`,
    customFieldsUnchanged: 'Nothing has changed yet',
    clearFieldLabel: (label: string) => `Clear ${label}`,
    /**
     * A stored `select` value that is no longer one of the definition's options.
     * Amendment 10 keeps it rather than rewriting the contact, so the form has to
     * offer it back or saving anything else would silently drop it.
     */
    staleOptionHint: 'No longer an option. Saving keeps it unless you pick another.',
    booleanTrue: 'Yes',
    booleanFalse: 'No',
    booleanUnset: 'Not set',
    selectUnset: 'Not set',
    notSet: 'Not set',
    readOnlyHint: 'You do not have permission to change this contact.',
  },

  customFields: {
    title: 'Custom fields',
    subtitle: 'The extra fields every contact in this workspace carries.',

    listHeading: 'Custom fields',
    listLoading: 'Loading custom fields',
    listDescription: (count: number, limit: number) =>
      `${count === 1 ? '1 field' : `${String(count)} fields`} of ${String(limit)}. They appear on every contact profile, in this order.`,
    emptyHeading: 'No custom fields yet',
    emptyBody:
      'Define a field such as “Plan tier” and every contact profile gains it, ready for an agent to fill in.',

    columnLabel: 'Label',
    columnKey: 'Key',
    columnType: 'Type',
    columnOptions: 'Options',
    columnActions: 'Actions',
    noOptions: '—',

    create: 'Define field',
    createTitle: 'Define a custom field',
    createDescription: 'It appears on every contact profile as soon as you save it.',
    createSubmit: 'Define field',
    createSuccess: (label: string) => `${label} added to every contact profile`,

    edit: 'Edit',
    editAria: (label: string) => `Edit ${label}`,
    editTitle: (label: string) => `Edit ${label}`,
    editSuccess: (label: string) => `${label} updated`,

    remove: 'Delete',
    removeAria: (label: string) => `Delete ${label}`,
    /**
     * A confirmation names the thing it is about to destroy, in its title as
     * well as in its body (0001, TAR-709). "Are you sure?" over a table of
     * near-identical rows asks the reader to remember which one they clicked.
     */
    removeTitle: (label: string) => `Delete ${label}?`,
    removeBody: (label: string) =>
      `${label} disappears from every contact profile, and the values already stored against it are deleted. This cannot be undone.`,
    removeConfirm: 'Delete field',
    removeSuccess: (label: string) => `${label} deleted`,

    labelLabel: 'Label',
    labelHint: 'What agents see on the contact profile. You can rename it at any time.',
    labelPlaceholder: 'Plan tier',

    keyLabel: 'Key',
    keyHint: 'Lowercase letters, numbers and underscores. Fixed once the field exists.',
    keyPlaceholder: 'plan_tier',
    keyInvalidError: 'Use lowercase letters, numbers and underscores, starting with a letter',
    keyReservedError: 'That key would shadow a built-in contact field. Pick another.',
    keyImmutableHint: 'The key cannot be changed — delete the field and define a new one.',

    typeLabel: 'Type',
    typeHint:
      'Fixed once the field exists, because the values already stored were checked against it.',
    typeImmutableHint: 'The type cannot be changed — delete the field and define a new one.',

    optionsLabel: 'Options',
    optionsHint: 'One per line. Removing one leaves it on any contact already holding it.',
    optionsPlaceholder: 'bronze\nsilver\ngold',
    optionsRequiredError: 'A choice field needs at least one option',
    optionsDuplicateError: 'Each option must be different',
    optionsTooManyError: (limit: number) => `At most ${String(limit)} options`,
    optionsTooLongError: (limit: number) =>
      `Each option must be at most ${String(limit)} characters`,

    limitReachedNotice: (limit: number) =>
      `This workspace has all ${String(limit)} custom fields it may define. Delete one to add another.`,
  },

  /**
   * The admin surface for the tenant's shared canned-response library
   * (TAR-31, TAR-575).
   *
   * Every visible string says **saved reply**, which `docs/STYLE.md` fixes as
   * the console's word on screen — `cannedResponses` is the code's word for the
   * same thing, and the composer's own copy beside `inbox.cannedListLabel`
   * already says it the same way.
   */
  cannedResponses: {
    title: 'Saved replies',
    subtitle: 'The standing replies your agents insert by typing a shortcut.',

    listHeading: 'Saved replies',
    listLoading: 'Loading saved replies',
    listDescription: (count: number, limit: number) =>
      `${count === 1 ? '1 saved reply' : `${String(count)} saved replies`} of ${String(limit)}. Everybody in this workspace sees the same list.`,
    emptyHeading: 'No saved replies yet',
    emptyBody:
      'Add one such as “Opening hours” and every agent can insert it in the reply box by typing its shortcut.',

    columnShortcut: 'Shortcut',
    columnName: 'Name',
    columnText: 'Text',
    columnActions: 'Actions',

    create: 'Add saved reply',
    createTitle: 'Add a saved reply',
    createDescription: 'Agents can use it the moment you save it — no reload needed.',
    createSubmit: 'Add saved reply',
    createSuccess: (title: string) => `${title} is ready for every agent to use`,

    edit: 'Edit',
    editAria: (title: string) => `Edit ${title}`,
    editTitle: (title: string) => `Edit ${title}`,
    editSuccess: (title: string) => `${title} updated`,

    remove: 'Delete',
    removeAria: (title: string) => `Delete ${title}`,
    /**
     * A confirmation names the thing it is about to destroy, in its title as
     * well as in its body (0001, TAR-709). "Are you sure?" over a table of
     * near-identical rows asks the reader to remember which one they clicked.
     */
    removeTitle: (title: string) => `Delete ${title}?`,
    removeBody: (title: string, shortcut: string) =>
      `${title} disappears from every agent's reply box, and ${shortcut} stops inserting anything. Messages already sent are untouched. This cannot be undone.`,
    removeConfirm: 'Delete saved reply',
    removeSuccess: (title: string) => `${title} deleted`,

    shortcutLabel: 'Shortcut',
    shortcutHint: (trigger: string) =>
      `What an agent types in the reply box, starting with ${trigger}. Lowercase letters, numbers, - and _.`,
    shortcutPlaceholder: '/hours',
    shortcutInvalidError: (trigger: string) =>
      `Start with ${trigger}, then lowercase letters, numbers, - or _`,
    shortcutTooLongError: (limit: number) =>
      `A shortcut is at most ${String(limit)} characters, including the leading /`,

    nameLabel: 'Name',
    nameHint: 'What agents see beside the shortcut when they pick from the list.',
    namePlaceholder: 'Opening hours',

    textLabel: 'Text',
    textHint: 'Inserted into the reply box exactly as written. Nothing is filled in automatically.',
    textPlaceholder: 'We’re open Sunday to Thursday, 9am to 6pm.',
    /** Read by an admin scanning the list, so it names the cap it was cut to. */
    textTruncatedAria: (limit: number) => `First ${String(limit)} characters. Edit to read it all.`,

    limitReachedNotice: (limit: number) =>
      `This workspace has all ${String(limit)} saved replies it may hold. Delete one to add another.`,
  },

  people: {
    title: 'People',
    subtitle: 'Agents, roles and teams in this workspace.',
    tabsLabel: 'People sections',
    agentsTab: 'Agents',
    teamsTab: 'Teams',

    agentsHeading: 'Agents',
    agentsLoading: 'Loading agents',
    agentsEmptyHeading: 'No agents yet',
    agentsEmptyBody: 'Invite a teammate to give them access to this workspace.',
    agentsCount: (count: number) => (count === 1 ? '1 agent' : `${count} agents`),
    agentsSectionDescription: (count: number) =>
      `${count === 1 ? '1 agent' : `${count} agents`}. Invited agents do not use a seat until they accept.`,
    columnName: 'Name',
    columnRole: 'Role',
    columnTeams: 'Teams',
    columnStatus: 'Status',
    columnAvailability: 'Availability',
    columnActions: 'Actions',
    filtersLabel: 'Agent filters',
    filterRoleLabel: 'Filter by role',
    /** Says what it filters, so the control needs no label above it (0001). */
    filterRoleAll: 'All roles',
    searchAgentsLabel: 'Search agents',
    searchAgentsPlaceholder: 'Name or email',

    inviteAgent: 'Invite agent',
    inviteAgentTitle: 'Invite an agent',
    inviteAgentDescription: 'They receive an email invitation and pick their own password.',
    inviteEmailLabel: 'Email address',
    inviteRoleLabel: 'Role',
    inviteTeamsLabel: 'Teams',
    inviteTeamsHint: 'Conversations routed to a team are visible to all of its members.',
    inviteSubmit: 'Send invitation',
    inviteSuccess: (email: string) => `Invitation sent to ${email}`,

    /**
     * The upgrade path shown when the API refuses an invitation because every
     * seat is taken (`plan_limit_exceeded`, TAR-37).
     *
     * It appears **only after that refusal**, never as a pre-check. The console
     * does not hold the authoritative seat count — an invitation accepted in
     * another tab changes it — so a dialog that disabled its own submit button
     * from a stale number would refuse invitations the API would have allowed.
     * The API's own message states the numbers; this adds the way out of it.
     */
    seatLimitUpgradeBody:
      'Adding a seat is the quickest fix. You can also withdraw an outstanding invitation or remove an agent.',
    seatLimitUpgradeLink: 'Compare plans',

    editAgent: 'Edit',
    editAgentAria: (name: string) => `Edit ${name}`,
    editAgentTitle: (name: string) => `Edit ${name}`,
    editNameLabel: 'Display name',
    editRoleLabel: 'Role',
    editTeamsLabel: 'Teams',
    editStatusLabel: 'Status',
    editSuccess: (name: string) => `${name} updated`,
    roleNotEditableHint: 'Only an admin can change someone’s role, and never their own.',
    roleNotAssignableHint: 'Only an admin can invite someone as a supervisor or an admin.',
    roleNotAssignableError: 'You can only invite someone as an agent.',
    roleEscalationError: 'You cannot give someone a role above your own.',
    selfRoleChangeError: 'You cannot change your own role. Ask another admin.',
    statusHint: 'Suspending someone cuts their access immediately and is reversible.',

    removeAgent: 'Remove',
    removeAgentAria: (name: string) => `Remove ${name}`,
    /**
     * A confirmation names the thing it is about to destroy, in its title as
     * well as in its body (0001, TAR-709). "Are you sure?" over a table of
     * near-identical rows asks the reader to remember which one they clicked.
     */
    removeAgentTitle: (name: string) => `Remove ${name} from this workspace?`,
    removeAgentBody: (name: string) =>
      `${name} loses access to this workspace immediately. Their conversations stay, but become unassigned.`,
    removeAgentConfirm: 'Remove agent',
    removeSuccess: (name: string) => `${name} removed`,

    teamsHeading: 'Teams',
    teamsSectionDescription: 'Conversations routed to a team are visible to every member.',
    teamsLoading: 'Loading teams',
    teamsEmptyHeading: 'No teams yet',
    teamsEmptyBody: 'Create a team such as Billing, then route conversations to it.',
    memberCount: (count: number) => (count === 1 ? '1 member' : `${count} members`),
    createTeam: 'Create team',
    createTeamTitle: 'Create a team',
    createTeamDescription: 'Conversations routed to a team are visible to every member.',
    teamNameLabel: 'Team name',
    teamNamePlaceholder: 'Billing',
    teamDescriptionLabel: 'Description',
    teamMembersLabel: 'Members',
    createTeamSubmit: 'Create team',
    createTeamSuccess: (name: string) => `Team ${name} created`,

    manageMembers: 'Manage members',
    manageMembersAria: (name: string) => `Manage members of ${name}`,
    manageMembersTitle: (name: string) => `Members of ${name}`,
    manageMembersDescription: 'Everyone selected here can see the team’s conversations.',
    manageMembersSuccess: (name: string) => `Members of ${name} updated`,

    noTeams: 'No teams',
  },

  assignment: {
    title: 'Assignment and reporting',
    subtitle: 'Workload across every agent and team in this workspace.',
    tenantScopeNotice: 'These figures cover this workspace only.',

    agentLoadHeading: 'Agent workload',
    agentLoadLoading: 'Loading agent workload',
    agentLoadEmptyHeading: 'No agents to report on',
    agentLoadEmptyBody: 'Invite agents and their workload appears here.',
    columnAgent: 'Agent',
    columnOpen: 'Open',
    columnUnread: 'Unread',

    teamLoadHeading: 'Team workload',
    teamLoadLoading: 'Loading team workload',
    teamLoadEmptyHeading: 'No teams to report on',
    teamLoadEmptyBody: 'Create a team and its workload appears here.',
    columnTeam: 'Team',
    columnMembers: 'Members',

    unassignedHeading: 'Waiting for assignment',
    unassignedLoading: 'Loading unassigned conversations',
    unassignedEmptyHeading: 'Nothing waiting',
    unassignedEmptyBody: 'Every conversation in this workspace has an owner.',
    unassignedCount: (count: number) =>
      count === 1 ? '1 conversation waiting' : `${count} conversations waiting`,

    /**
     * The supervisor's flagged-ticket queue (TAR-23). Auto-assignment leaves a
     * ticket here when it could not place it, so every line has to say what
     * happened *and* who can act on it — a supervisor staring at "unassigned"
     * cannot tell a staffing problem from a configuration one.
     */
    flaggedHeading: 'Flagged for you',
    flaggedDescription:
      'Auto-assignment could not place these tickets. Assign one to take it off this list.',
    flaggedLoading: 'Loading flagged tickets',
    flaggedEmptyHeading: 'Nothing is stuck',
    flaggedEmptyBody: 'Every ticket in this workspace reached an agent.',
    flaggedFilteredEmptyHeading: 'No tickets for that reason',
    flaggedFilteredEmptyBody: 'Other tickets may still be flagged.',
    flaggedFilteredEmptyAction: 'Show every reason',
    flaggedCount: (count: number) =>
      count === 1 ? '1 ticket flagged' : `${count} tickets flagged`,
    /**
     * Shown instead of a count when the queue is longer than one page. It says
     * what is on screen and admits what is not — a bare number here would be a
     * claim about the whole queue that the request never made.
     *
     * "Longest-waiting" is a claim about the API's order, and it is true because
     * `?routingState=deferred` pages `routingDeferredSince ASC` — oldest stuck
     * first (ADR 0008 decision 3, amendment 3; TAR-365). It was written before
     * that predicate shipped and was briefly ahead of the implementation; if the
     * order ever changes, this string changes with it rather than quietly
     * over-claiming again.
     */
    flaggedShowingOldest: (count: number) =>
      `Showing the ${String(count)} longest-waiting. More are flagged than fit on one page.`,

    columnTicket: 'Ticket',
    columnReason: 'Why it is unassigned',
    columnWaiting: 'Waiting',
    columnAssign: 'Assign',
    waitingSinceLabel: 'Flagged',
    untitledTicket: (ticketNumber: number) => `Ticket #${String(ticketNumber)}`,
    ticketNumber: (ticketNumber: number) => `#${String(ticketNumber)}`,

    reasonFilterLabel: 'Reason a ticket is unassigned',
    reasonFilterAll: 'All reasons',

    /** ADR 0008's three reasons. Each names the person who can actually fix it. */
    deferredReasons: {
      all_at_capacity: 'Everyone at capacity',
      none_available: 'Nobody available',
      no_candidate_pool: 'No agents to route to',
    } satisfies Record<FallbackAssignmentReason, string>,

    deferredReasonHints: {
      all_at_capacity:
        'Every agent who could take this is at their concurrent-ticket limit. Wait, raise a limit, or assign it anyway.',
      none_available:
        'Agents exist for this ticket, but none is available and recently active. This is a staffing gap.',
      no_candidate_pool:
        'Nobody could ever have taken this: the team has no members, or the workspace has no agents.',
    } satisfies Record<FallbackAssignmentReason, string>,

    assignTicket: 'Assign',
    assignTicketAria: (ticketLabel: string) => `Assign ${ticketLabel}`,
    assignTicketTitle: (ticketLabel: string) => `Assign ${ticketLabel}`,
    assignTicketDescription:
      'The agent you pick takes this ticket now, even if they are at their limit. Auto-assignment will not move it again.',
    assignTicketAgentLabel: 'Assign to',
    /**
     * "Anyone in this list", not "anyone in this workspace": the picker holds the
     * first page of active people, so a large workspace has more. It still has to
     * say that being at a limit is no bar and that picking yourself is allowed —
     * that is the remedy ADR 0008 names for `all_at_capacity`.
     */
    assignTicketAgentHint: 'Anyone in this list can take it, including you — even at their limit.',
    assignTicketReasonLabel: 'Why this person',
    /**
     * Offered, not demanded. A flagged ticket has no holder, and the API only
     * asks for a reason when the placement takes work away from somebody (ADR
     * 0011 decision 1) — so on every row this queue can show, the field is
     * skippable and says so (TAR-537).
     *
     * Takes the flag rather than hardcoding "Optional" because the dialog reads
     * `ticketAssignRequiresReason` rather than assuming its answer: copy that
     * said "optional" beside a required asterisk is the drift this parameter
     * exists to prevent.
     */
    assignTicketReasonHint: (isRequired: boolean) =>
      isRequired
        ? 'Recorded on the ticket’s history as the reason it was taken from its current holder.'
        : 'Optional. Anything you write is recorded on the ticket’s history as the reason for the override.',
    assignTicketSubmit: 'Assign ticket',
    assignTicketSuccess: (ticketLabel: string, agentName: string) =>
      `${ticketLabel} assigned to ${agentName}`,
    assignTicketNoAgentsError: 'Nobody in this workspace is active enough to take a ticket.',

    /**
     * The cap-edit control (TAR-384). A supervisor looking at "everyone at
     * capacity" needs a path to raise the limit that is in the way without
     * leaving the console — and copy that is honest about what raising it does
     * and does not do.
     */
    editCapacity: 'Agent limits',
    editCapacityAria: (ticketLabel: string) => `Change agent limits for ${ticketLabel}`,
    capacityTitle: 'Agent ticket limits',
    /**
     * Says what the write actually achieves. Raising a limit frees the agent for
     * the *next* ticket routing places; nothing re-routes a ticket already
     * deferred, so the row in front of the supervisor stays flagged until they
     * assign it. Left unsaid, the control reads as if the ticket places itself,
     * and it does not.
     */
    capacityDescription:
      'A higher limit frees that agent for the next ticket auto-assignment routes. It does not move this one — assign it when you are ready.',
    capacityAgentLabel: 'Agent',
    capacityAgentHint: 'Agents already at their limit are listed first.',
    /** Said out loud rather than implied: the picker holds one page of agents. */
    capacityAgentHintTruncated:
      'Agents already at their limit are listed first. This list holds the first page of agents in this workspace.',
    capacityAgentOption: (name: string, active: number, limit: number) =>
      `${name} — ${String(active)} of ${String(limit)}`,
    capacityLoadLabel: 'Holding now',
    capacityLoad: (active: number, limit: number) =>
      `${String(active)} of ${String(limit)} tickets`,
    capacityAtLimit: 'At their limit',
    capacityHasRoom: 'Has room',
    capacityInherited: (workspaceDefault: number) =>
      `No limit of their own — inherits the workspace default of ${String(workspaceDefault)}.`,
    capacityOverridden: 'Set for this agent, rather than inherited.',
    capacityLimitSourceLegend: 'Where this agent’s limit comes from',
    capacityLimitLabel: 'Ticket limit',
    capacityLimitHint: (min: number, max: number) =>
      `A whole number between ${String(min)} and ${String(max)}.`,
    capacityUseDefaultLabel: (workspaceDefault: number) =>
      `Use the workspace default of ${String(workspaceDefault)}`,
    capacityRangeError: (min: number, max: number) =>
      `Enter a whole number between ${String(min)} and ${String(max)}.`,
    /**
     * ADR 0008's failure-mode table rules that lowering a cap below an agent's
     * current load takes no ticket off them — they are skipped by rotation until
     * they close down to it. It looks like a bug from the queue, so it is said
     * before the supervisor presses save rather than discovered afterwards.
     */
    capacityBelowLoadWarning: (name: string, active: number) =>
      `${name} is holding ${String(active)}. A lower limit takes none of those away — they stop receiving new tickets until they are back under it.`,
    capacitySubmit: 'Save limit',
    capacitySuccess: (name: string, limit: number) =>
      limit === 1
        ? `${name} can now hold 1 ticket at a time`
        : `${name} can now hold ${String(limit)} tickets at a time`,
    capacityClearedSuccess: (name: string, workspaceDefault: number) =>
      `${name} now uses the workspace default of ${String(workspaceDefault)}`,
    /**
     * The permission-denied state, seen from inside the control. Read-only rather
     * than hidden: knowing where the limit sits is what tells a supervisor whether
     * to wait or to escalate, and hiding it would leave them guessing.
     */
    capacityReadOnlyNotice:
      'Only a supervisor or an admin can change an agent’s limit. You can see the limits here, not edit them.',

    routedToTeam: (teamName: string) => `${teamName} team`,
    routedToNobody: 'Whole workspace',
  },

  /**
   * The routing-rule builder (TAR-24). Every string the supervisor reads while
   * writing a rule, including the plain-language summary of each condition — the
   * summary is copy, not a rendering of the grammar, so it belongs here rather
   * than in the component that shows it.
   */
  routingRules: {
    heading: 'Routing rules',
    sectionDescription:
      'Rules are checked in order, top first. The first rule that matches decides where a new conversation goes; if none matches, it falls back to the usual rotation.',
    loading: 'Loading routing rules',
    emptyHeading: 'No routing rules yet',
    emptyBody:
      'Add a rule to send matching conversations straight to the right team, instead of waiting for the rotation.',

    listLabel: 'Routing rules, in the order they are checked',
    orderPosition: (index: number) => `Rule ${index}`,
    active: 'Active',
    inactive: 'Off',
    conditionsHeading: 'Matches when',
    targetHeading: 'Route to',

    addRule: 'Add rule',
    addRuleTitle: 'Add a routing rule',
    addRuleSubmit: 'Add rule',
    editRule: 'Edit',
    editRuleAria: (name: string) => `Edit ${name}`,
    editRuleTitle: (name: string) => `Edit ${name}`,
    editRuleSubmit: 'Save changes',
    moveUp: 'Move up',
    moveUpAria: (name: string) => `Move ${name} earlier`,
    moveDown: 'Move down',
    moveDownAria: (name: string) => `Move ${name} later`,
    enable: 'Turn on',
    enableAria: (name: string) => `Turn on ${name}`,
    disable: 'Turn off',
    disableAria: (name: string) => `Turn off ${name}`,
    deleteRule: 'Delete',
    deleteRuleAria: (name: string) => `Delete ${name}`,
    deleteRuleTitle: 'Delete routing rule',
    deleteRuleBody: (name: string) =>
      `${name} stops applying immediately. Conversations it already routed keep their assignment, and this cannot be undone.`,
    deleteRuleConfirm: 'Delete rule',

    nameLabel: 'Rule name',
    namePlaceholder: 'Billing keywords',
    nameHint: 'Shown in a conversation’s history as the reason it was routed.',
    nameRequiredError: 'Give the rule a name',
    nameTooLongError: (maxLength: number) => `Use at most ${String(maxLength)} characters`,

    conditionsLegend: 'Conditions',
    conditionsHint: 'A conversation has to match every condition for the rule to apply.',
    conditionsRequiredError: 'Add at least one condition',
    conditionsFullHint: (maxCount: number) =>
      `A rule can hold up to ${String(maxCount)} conditions.`,
    addCondition: 'Add condition',
    removeCondition: 'Remove',
    removeConditionAria: (index: number) => `Remove condition ${String(index)}`,
    conditionNumber: (index: number) => `Condition ${String(index)}`,
    conditionTypeLabel: 'Check',

    conditionTypeKeyword: 'Words in the message',
    conditionTypeTag: 'Contact tag',
    conditionTypeBusinessHours: 'Business hours',
    conditionTypeContactAttribute: 'Contact field',

    matchLabel: 'Match',
    matchAny: 'Any of them',
    matchAll: 'All of them',

    keywordValuesLabel: 'Words or phrases',
    keywordValuesHint: 'One per line. Matching ignores capitals and matches inside longer words.',
    keywordValuesRequiredError: 'Add at least one word or phrase',
    keywordValuesTooManyError: (maxCount: number) =>
      `Use at most ${String(maxCount)} words or phrases`,
    keywordTooLongError: (maxLength: number) =>
      `Keep each word under ${String(maxLength)} characters`,

    tagsLabel: 'Tags',
    tagsRequiredError: 'Choose at least one tag',
    tagsTooManyError: (maxCount: number) => `Choose at most ${String(maxCount)} tags`,
    tagsUnavailable:
      'This workspace has no contact tags yet, so a tag condition has nothing to match on.',

    businessHoursLabel: 'The conversation arrived',
    businessHoursWithin: 'Inside business hours',
    businessHoursOutside: 'Outside business hours',
    businessHoursNotice:
      'This uses the business hours set for the workspace. Until those are set, the condition never matches and the rule is skipped.',

    attributeKeyLabel: 'Contact field',
    attributeOperatorLabel: 'Comparison',
    attributeValueLabel: 'Value',
    attributeValueRequiredError: 'Enter a value to compare against',
    operatorEquals: 'is exactly',
    operatorNotEquals: 'is not',
    operatorContains: 'contains',
    operatorIsSet: 'is filled in',
    operatorIsNotSet: 'is empty',

    targetKindLabel: 'Send to a',
    targetKindTeam: 'Team',
    targetKindUser: 'Agent',
    targetTeamLabel: 'Team',
    targetUserLabel: 'Agent',
    targetRequiredError: 'Choose where matching conversations should go',
    targetMissing: 'No target — this rule needs one before it can be turned on',
    targetMissingHint:
      'The agent this rule pointed at was removed. Choose a new target, then turn the rule back on.',
    noTeamsHint: 'Create a team on the People page first.',

    /** Plain-language summaries of a condition, one per shape it can take. */
    summaryKeywordAny: (values: string) => `the message mentions ${values}`,
    summaryKeywordAll: (values: string) => `the message mentions ${values}`,
    summaryTagAny: (tags: string) => `the contact is tagged ${tags}`,
    summaryTagAll: (tags: string) => `the contact is tagged ${tags}`,
    summaryBusinessHoursWithin: 'it arrives inside business hours',
    summaryBusinessHoursOutside: 'it arrives outside business hours',
    summaryAttribute: (field: string, comparison: string) => `${field} ${comparison}`,
    summaryAttributeValue: (comparison: string, value: string) => `${comparison} “${value}”`,
    /** A tag or field the rule names that no longer exists in the workspace. */
    summaryUnknownReference: 'a deleted item',

    routeToTeam: (name: string) => `the ${name} team`,
    routeToUser: (name: string) => name,
    unknownTeam: 'a deleted team',
    unknownUser: 'a removed agent',

    createSuccess: (name: string) => `Rule ${name} added`,
    updateSuccess: (name: string) => `Rule ${name} saved`,
    deleteSuccess: (name: string) => `Rule ${name} deleted`,
    enableSuccess: (name: string) => `Rule ${name} is on`,
    disableSuccess: (name: string) => `Rule ${name} is off`,
    reorderSuccess: 'Rule order saved',
  },

  /**
   * The automation builder (TAR-27). Its vocabulary is deliberately *not* the
   * routing rules' vocabulary: a routing rule decides where a conversation goes
   * and the first match wins, while every matching workflow runs and each one
   * writes to a ticket. Sharing the copy would flatten a difference a supervisor
   * has to understand.
   */
  workflows: {
    title: 'Workflows',
    subtitle: 'Automate what happens to a ticket, without anybody watching.',
    heading: 'Workflows',
    sectionDescription:
      'Every workflow that matches runs, in the order below. A new workflow starts switched off — test it against a real ticket, then turn it on.',
    loading: 'Loading workflows',
    emptyHeading: 'No workflows yet',
    emptyBody:
      'Add a workflow to escalate, tag or reassign tickets automatically instead of watching the queue for them.',
    limitReachedHint: (maxCount: number) =>
      `This workspace has reached its limit of ${String(maxCount)} workflows. Delete one to add another.`,

    listLabel: 'Workflows, in the order they run',
    orderPosition: (index: number) => `Workflow ${String(index)}`,
    active: 'On',
    inactive: 'Off',
    triggerHeading: 'Runs when',
    conditionsHeading: 'And only when',
    actionsHeading: 'Then',
    alwaysMatches: 'every time — this workflow has no conditions',

    addWorkflow: 'Add workflow',
    addWorkflowTitle: 'Add a workflow',
    addWorkflowSubmit: 'Add workflow',
    editWorkflow: 'Edit',
    editWorkflowAria: (name: string) => `Edit ${name}`,
    editWorkflowTitle: (name: string) => `Edit ${name}`,
    editWorkflowSubmit: 'Save changes',
    moveUp: 'Move up',
    moveUpAria: (name: string) => `Move ${name} earlier`,
    moveDown: 'Move down',
    moveDownAria: (name: string) => `Move ${name} later`,
    enable: 'Turn on',
    enableAria: (name: string) => `Turn on ${name}`,
    disable: 'Turn off',
    disableAria: (name: string) => `Turn off ${name}`,
    testWorkflow: 'Test',
    testWorkflowAria: (name: string) => `Test ${name} against a ticket`,
    viewRuns: 'History',
    viewRunsAria: (name: string) => `Recent runs of ${name}`,
    deleteWorkflow: 'Delete',
    deleteWorkflowAria: (name: string) => `Delete ${name}`,
    deleteWorkflowTitle: 'Delete workflow',
    deleteWorkflowBody: (name: string) =>
      `${name} stops running immediately. Tickets it already changed keep those changes, and this cannot be undone.`,
    deleteWorkflowConfirm: 'Delete workflow',

    nameLabel: 'Workflow name',
    namePlaceholder: 'Escalate stale tickets',
    nameHint: 'Shown in the run history as the reason a ticket changed.',
    nameRequiredError: 'Give the workflow a name',
    nameTooLongError: (maxLength: number) => `Use at most ${String(maxLength)} characters`,

    triggerLegend: 'Trigger',
    triggerHint: 'What has to happen to a ticket for this workflow to consider it.',
    triggerTypeLabel: 'Run when',
    minutesLabel: 'After',
    minutesUnit: 'minutes',
    minutesHint: (minMinutes: number, maxMinutes: number) =>
      `Between ${String(minMinutes)} minutes and ${String(maxMinutes)} minutes (30 days). Detection can lag by up to a minute.`,
    minutesRangeError: (minMinutes: number, maxMinutes: number) =>
      `Enter a whole number of minutes between ${String(minMinutes)} and ${String(maxMinutes)}`,

    conditionsLegend: 'Conditions',
    conditionsHint:
      'A ticket has to match every condition. Leave this empty to run every time the trigger fires.',
    conditionsFullHint: (maxCount: number) =>
      `A workflow can hold up to ${String(maxCount)} conditions.`,
    addCondition: 'Add condition',
    removeCondition: 'Remove',
    removeConditionAria: (index: number) => `Remove condition ${String(index)}`,
    conditionNumber: (index: number) => `Condition ${String(index)}`,
    conditionTypeLabel: 'Check',

    actionsLegend: 'Actions',
    actionsHint:
      'Run in the order below. If one fails, the ones after it are skipped and the run says which.',
    actionsFullHint: (maxCount: number) => `A workflow can hold up to ${String(maxCount)} actions.`,
    addAction: 'Add action',
    removeAction: 'Remove',
    removeActionAria: (index: number) => `Remove action ${String(index)}`,
    actionNumber: (index: number) => `Action ${String(index)}`,
    actionTypeLabel: 'Do',
    actionsRequiredError: 'Add at least one action',

    operatorLabel: 'Comparison',
    matchLabel: 'Match',
    statusValuesLabel: 'Statuses',
    statusValuesRequiredError: 'Choose at least one status',
    priorityValuesLabel: 'Priorities',
    priorityValuesRequiredError: 'Choose at least one priority',
    assignmentStateLabel: 'Assignment',
    assignmentTeamLabel: 'Team',
    assignmentUserLabel: 'Agent',
    anyTeam: 'Any team',
    anyUser: 'Anyone',
    tagsLabel: 'Tags',
    tagsRequiredError: 'Choose at least one tag',
    tagsTooManyError: (maxCount: number) => `Choose at most ${String(maxCount)} tags`,
    tagsUnavailable: 'This workspace has no tags yet, so a tag condition has nothing to match on.',
    ageMinutesLabel: 'Age in minutes',
    businessHoursLabel: 'The ticket is',
    businessHoursWithin: 'Inside business hours',
    businessHoursOutside: 'Outside business hours',
    businessHoursNotice:
      'This uses the business hours set for the workspace. Until those are set, the condition never matches and the workflow is skipped.',

    tagLabel: 'Tag',
    tagRequiredError: 'Choose a tag to apply',
    assigneeKindLabel: 'Reassign to a',
    assigneeKindTeam: 'Team',
    assigneeKindUser: 'Agent',
    assigneeTeamLabel: 'Team',
    assigneeUserLabel: 'Agent',
    assigneeRequiredError: 'Choose who the ticket should go to',
    noTeamsHint: 'Create a team on the People page first.',
    notifyAudienceLabel: 'Notify',
    notifyUserLabel: 'Agent',
    notifyTeamLabel: 'Team',
    notifyUserRequiredError: 'Choose who to notify',
    notifyTeamRequiredError: 'Choose which team to notify',
    messageLabel: 'Note',
    messageHint: (maxLength: number) =>
      `Optional. Shown with the notification, at most ${String(maxLength)} characters. The ticket number is included automatically.`,
    messageTooLongError: (maxLength: number) => `Use at most ${String(maxLength)} characters`,
    statusLabel: 'Status',
    priorityLabel: 'Priority',

    triggerTypes: {
      ticket_created: 'A ticket is created',
      ticket_status_changed: 'A ticket’s status changes',
      ticket_assigned: 'A ticket is assigned or unassigned',
      ticket_sla_breached: 'A ticket misses its SLA',
      ticket_unresolved_for: 'A ticket stays unresolved',
    } satisfies Record<WorkflowTriggerType, string>,

    conditionTypes: {
      ticket_status: 'Ticket status',
      ticket_priority: 'Ticket priority',
      ticket_assignment: 'Who it is assigned to',
      ticket_tag: 'Ticket tag',
      contact_tag: 'Contact tag',
      ticket_age: 'Ticket age',
      business_hours: 'Business hours',
    } satisfies Record<WorkflowConditionType, string>,

    actionTypes: {
      add_ticket_tag: 'Tag the ticket',
      reassign: 'Reassign the ticket',
      notify: 'Notify someone',
      set_status: 'Change the status',
      set_priority: 'Change the priority',
    } satisfies Record<WorkflowActionType, string>,

    setOperators: {
      in: 'Is one of',
      not_in: 'Is not one of',
    } satisfies Record<WorkflowSetOperator, string>,

    matchOperators: {
      any: 'Any of them',
      all: 'All of them',
      none: 'None of them',
    } satisfies Record<WorkflowMatchOperator, string>,

    numberOperators: {
      gte: 'At least',
      lte: 'At most',
    } satisfies Record<WorkflowNumberOperator, string>,

    assignmentStates: {
      unassigned: 'Nobody is assigned',
      assigned_to_user: 'Assigned to an agent',
      assigned_to_team: 'Assigned to a team',
    } satisfies Record<WorkflowAssignmentState, string>,

    /**
     * Two tables for one enum, because they answer different questions. The
     * picker asks "who should this notify?" and the summary finishes the
     * sentence "notify …", so one set of strings could only ever read wrong in
     * one of the two places.
     */
    notifyAudienceOptions: {
      supervisors: 'The supervisors',
      user: 'One agent',
      team: 'A team',
    } satisfies Record<WorkflowNotifyAudience, string>,

    notifyAudiences: {
      supervisors: 'the supervisors',
      user: 'one agent',
      team: 'a team',
    } satisfies Record<WorkflowNotifyAudience, string>,

    referenceKinds: {
      tag: 'a tag',
      team: 'a team',
      user: 'an agent',
    } satisfies Record<WorkflowTaxonomyKind, string>,

    brokenReasons: {
      reference_removed: 'Something this workflow points at was removed, so it was switched off.',
      reference_missing:
        'Something this workflow points at went missing while it was running, so it was switched off.',
      reference_suspended:
        'Someone this workflow points at was suspended, so it was switched off. Reinstate them or pick a replacement.',
    } satisfies Record<WorkflowBrokenReason, string>,

    runStatuses: {
      pending: 'Queued',
      running: 'Running',
      succeeded: 'Ran',
      skipped: 'Conditions did not match',
      failed: 'Failed',
    } satisfies Record<WorkflowRunStatus, string>,

    failureReasons: {
      reference_missing: 'Something it points at no longer exists',
      transition_refused: 'That status change is not allowed on this ticket',
      ticket_gone: 'The ticket was gone by the time it ran',
      run_budget_exceeded: 'This ticket hit the hourly limit on automated changes',
      internal_error: 'Something went wrong on our side',
    } satisfies Record<WorkflowFailureReason, string>,

    actionOutcomes: {
      applied: 'Applied',
      no_op: 'Nothing to change',
      failed: 'Failed',
      skipped: 'Skipped',
    } satisfies Record<WorkflowActionOutcome, string>,

    /** Plain-language summaries, one per shape a trigger, condition or action takes. */
    summaryTriggerCreated: 'a ticket is created',
    summaryTriggerStatusChanged: 'a ticket’s status changes',
    summaryTriggerAssigned: 'a ticket is assigned or unassigned',
    summaryTriggerSlaBreached: 'a ticket misses its SLA',
    summaryTriggerUnresolvedFor: (duration: string) =>
      `a ticket has been unresolved for ${duration}`,
    summaryStatusIn: (statuses: string) => `its status is ${statuses}`,
    summaryStatusNotIn: (statuses: string) => `its status is not ${statuses}`,
    summaryPriorityIn: (priorities: string) => `its priority is ${priorities}`,
    summaryPriorityNotIn: (priorities: string) => `its priority is not ${priorities}`,
    summaryUnassigned: 'nobody is assigned to it',
    summaryAssignedToAnyone: 'it is assigned to an agent',
    summaryAssignedToUser: (name: string) => `it is assigned to ${name}`,
    summaryAssignedToAnyTeam: 'it is assigned to a team',
    /** Takes the whole team phrase, so a deleted team reads as one too. */
    summaryAssignedToTeam: (team: string) => `it is assigned to ${team}`,
    summaryTicketTagged: (tags: string) => `the ticket is tagged ${tags}`,
    summaryTicketNotTagged: (tags: string) => `the ticket is not tagged ${tags}`,
    summaryContactTagged: (tags: string) => `the contact is tagged ${tags}`,
    summaryContactNotTagged: (tags: string) => `the contact is not tagged ${tags}`,
    summaryAgeAtLeast: (duration: string) => `it is at least ${duration} old`,
    summaryAgeAtMost: (duration: string) => `it is at most ${duration} old`,
    summaryWithinHours: 'it is inside business hours',
    summaryOutsideHours: 'it is outside business hours',
    summaryAddTag: (tag: string) => `tag the ticket ${tag}`,
    summaryReassign: (assignee: string) => `reassign it to ${assignee}`,
    summaryNotify: (audience: string) => `notify ${audience}`,
    summaryNotifyWithMessage: (audience: string, message: string) =>
      `notify ${audience}: “${message}”`,
    summarySetStatus: (status: string) => `set its status to ${status}`,
    summarySetPriority: (priority: string) => `set its priority to ${priority}`,
    targetTeamName: (name: string) => `the ${name} team`,
    /**
     * What a reference the workflow still names but that no longer resolves
     * reads as. One per kind, because they sit in different sentences: "notify a
     * deleted item" is not English, and a supervisor reading "a removed agent"
     * knows which picker to go and fix.
     */
    unknownReference: 'a deleted item',
    unknownTeam: 'a deleted team',
    unknownUser: 'a removed agent',

    brokenHeading: 'This workflow needs attention',
    brokenBody: (references: string) =>
      `It points at ${references} that no longer exists. Choose a replacement, then turn it back on.`,
    brokenCannotEnable: 'Fix the missing reference before turning this workflow on.',

    testTitle: (name: string) => `Test ${name}`,
    testIntro:
      'Checks this workflow against one real ticket and reports what would happen. Nothing is changed.',
    testTicketLabel: 'Ticket ID',
    testTicketHint: 'Paste the ID of a ticket to check this workflow against.',
    testTicketRequiredError: 'Enter a ticket ID',
    testSubmit: 'Run test',
    testLoading: 'Checking the ticket',
    testMatched: 'This workflow would run on that ticket.',
    testNotMatched: 'This workflow would not run on that ticket.',
    testConditionsHeading: 'Conditions',
    testActionsHeading: 'What would happen',
    testNoConditions: 'This workflow has no conditions, so the trigger alone decides.',
    testHeld: 'Held',
    testNotHeld: 'Did not hold',
    testNoActions: 'Nothing, because the conditions did not match.',

    runsTitle: (name: string) => `Recent runs of ${name}`,
    runsIntro:
      'The most recent runs, newest first. Start here when a workflow is not doing what you expect.',
    runsLoading: 'Loading recent runs',
    runsEmptyHeading: 'No runs yet',
    runsEmptyBody:
      'This workflow has not run since it was created. A workflow that is switched off never runs.',
    runTicket: (ticketNumber: number) => `Ticket #${String(ticketNumber)}`,
    runNothingAttempted: 'Its conditions did not match, so no action was attempted.',

    createSuccess: (name: string) => `Workflow ${name} added`,
    updateSuccess: (name: string) => `Workflow ${name} saved`,
    deleteSuccess: (name: string) => `Workflow ${name} deleted`,
    enableSuccess: (name: string) => `Workflow ${name} is on`,
    disableSuccess: (name: string) => `Workflow ${name} is off`,
    reorderSuccess: 'Workflow order saved',
  },

  whatsapp: {
    title: 'WhatsApp',
    subtitle: 'Connect this workspace to your WhatsApp Business Account.',
    loading: 'Loading WhatsApp settings',

    connectHeading: 'WhatsApp Business Account',
    connectDescription:
      'Meta hosts this connection. You sign in to Meta, choose the business account and the number, and come straight back here.',
    connectIntro:
      'Connecting brings your WhatsApp numbers into this workspace, so conversations arrive in the inbox and your team replies from here. Nothing is shared with Meta beyond what you approve in their window.',
    connectButton: 'Connect WhatsApp',
    connectAnotherButton: 'Connect another account',
    /** Shown while Meta's own window is open — the wait belongs to them, not to us. */
    authorisingHeading: 'Waiting for Meta',
    authorisingBody:
      'Finish the steps in Meta’s window. If you cannot see it, check for a blocked pop-up.',
    /**
     * The interval between Meta returning and the workspace being connected.
     * Worth its own line: the authorisation Meta hands back is valid for about 30
     * seconds, so this is the one moment nobody should navigate away.
     */
    connectingHeading: 'Finishing the connection',
    connectingBody:
      'Meta has authorised the connection and we are setting it up. Stay on this page — it only takes a moment.',

    unconfiguredHeading: 'Self-service connection isn’t available',
    unconfiguredBody:
      'This console has no Meta app configured for connecting WhatsApp yourself. Contact support and they can connect your WhatsApp Business Account for you.',
    /**
     * The copy instructs "contact support", so the state offers it as a real
     * link rather than leaving the reader to find an address (TAR-515). Only
     * rendered when `NEXT_PUBLIC_SUPPORT_EMAIL` is configured: a button that
     * opened a blank mail draft would be worse than the sentence alone.
     */
    unconfiguredSupportAction: 'Contact support',
    /** Prefills the subject, so the operator knows which console and which ask. */
    unconfiguredSupportSubject: 'Connect our WhatsApp Business Account',

    connectedHeading: 'Connected account',
    connectedToast: (name: string) => `${name} connected`,
    connectedNumbersCaption: 'Connected WhatsApp numbers',
    connectedNumbersCount: (count: number) =>
      count === 1 ? '1 connected number' : `${count} connected numbers`,
    columnNumber: 'Number',
    columnVerifiedName: 'Verified name',
    columnQuality: 'Quality rating',
    columnNumberStatus: 'Status',
    wabaIdLabel: 'Meta business account ID',
    unnamedAccount: 'WhatsApp Business Account',
    noVerifiedName: 'Not set yet',
    noQualityRating: 'Not rated yet',
    /**
     * The gap Phase 6 (TAR-170) is parked on, said plainly rather than left to be
     * discovered as "sending is broken": a number Meta never registered for Cloud
     * API use can receive here but cannot send.
     */
    registrationNotice:
      'A number that has never been registered for the WhatsApp Cloud API can receive messages here but cannot send yet. Contact support to finish registering it.',

    verificationStatuses: {
      not_verified: 'Not verified',
      pending: 'Verification pending',
      verified: 'Verified',
      rejected: 'Verification rejected',
    } satisfies Record<WhatsAppBusinessVerificationStatus, string>,

    qualityRatings: {
      green: 'High',
      yellow: 'Medium',
      red: 'Low',
      // Meta's own value: it has rated the number and cannot place it.
      unknown: 'Unrated by Meta',
    } satisfies Record<WhatsAppQualityRating, string>,

    accountStatuses: {
      connected: 'Connected',
      disconnected: 'Disconnected',
      error: 'Error',
    } satisfies Record<WhatsAppAccountStatus, string>,

    /**
     * One entry per outcome the connection flow can end in, keyed by
     * `WhatsAppConnectFailure`. Distinct copy per key is the point of the
     * `details.reason` taxonomy: "something went wrong" would throw away the one
     * thing that tells somebody whether to try again, grant a permission, or
     * call support (0002, amendment 2).
     *
     * Whether a key offers the button again is `isConnectFailureRetryable`'s
     * decision, not this table's — copy stays copy.
     */
    connectFailures: {
      code_expired: {
        heading: 'The connection took too long',
        body: 'Meta’s authorisation is valid for about 30 seconds. Start again and complete Meta’s steps without pausing.',
      },
      code_invalid: {
        heading: 'Meta rejected this authorisation',
        body: 'Start the connection again to get a fresh authorisation from Meta.',
      },
      insufficient_permissions: {
        heading: 'Some permissions were not granted',
        body: 'This connection needs WhatsApp business management, WhatsApp messaging and business management. Start again and accept every permission Meta asks for.',
      },
      waba_mismatch: {
        heading: 'That business account could not be read',
        body: 'The access Meta granted does not cover the WhatsApp Business Account it named. Contact support — starting again will not change this.',
      },
      signup_failed: {
        heading: 'The connection could not be completed',
        body: 'Meta accepted the sign-in but the account could not be set up. Start again, and contact support if it happens twice.',
      },
      meta_error: {
        heading: 'Meta could not complete the connection',
        body: 'Meta reported a problem part-way through. Start again, and contact support if it keeps happening.',
      },
      conflict: {
        heading: 'That account is already connected',
        body: 'This WhatsApp Business Account or one of its numbers belongs to another workspace. Contact support to move it.',
      },
      rate_limited: {
        heading: 'Meta is limiting requests right now',
        body: 'Too many requests reached Meta just now. Wait a few minutes, then start the connection again.',
      },
      upstream_unavailable: {
        heading: 'Meta is not responding',
        body: 'Meta could not be reached. Start the connection again shortly.',
      },
      forbidden: {
        heading: 'You cannot connect an account',
        body: 'Your role no longer includes managing channels. Ask a workspace admin.',
      },
      cancelled: {
        heading: 'Connection cancelled',
        body: 'Meta’s window closed before the connection finished. Start again whenever you are ready.',
      },
      timed_out: {
        heading: 'The connection did not finish',
        body: 'Meta started the connection but never confirmed it. Nothing was changed in this workspace — start again, and contact support if it happens twice.',
      },
      sdk_unavailable: {
        heading: 'Meta’s connection window could not load',
        body: 'Something blocked Meta’s script — an ad blocker or a strict privacy setting is the usual cause. Allow connect.facebook.net, reload this page, and try again.',
      },
      unknown: {
        heading: 'We could not complete the connection',
        body: 'Something went wrong on the way to Meta. Start the connection again.',
      },
    },
  },

  /**
   * The guided onboarding checklist (TAR-407). Second person throughout — this is
   * the one surface that talks to an admin about their own workspace rather than
   * about the records in it.
   */
  onboarding: {
    title: 'Getting started',
    subtitle: 'Three things to set up before your team starts replying.',
    loading: 'Loading your setup checklist',

    checklistHeading: 'Set up your workspace',
    checklistDescription:
      'Work through these in any order. You can skip a step and come back to it whenever you like — nothing here expires.',

    /** The meter's accessible name; the visible count sits beside it. */
    progressLabel: 'Setup progress',
    progressCount: (resolved: number, total: number) => `${resolved} of ${total} done`,

    statuses: {
      pending: 'To do',
      completed: 'Done',
      /** Not a failure — a deliberate "later", and reversible. */
      skipped: 'Skipped later',
    } satisfies Record<OnboardingStepStatus, string>,

    skip: 'Skip for now',
    /** Puts a skipped step back on the list. */
    unskip: 'Put back on the list',
    skippedToast: (step: string) => `${step} skipped — it stays on this list`,
    unskippedToast: (step: string) => `${step} is back on your list`,

    steps: {
      connect_whatsapp: {
        title: 'Connect a WhatsApp number',
        summary: 'Bring your WhatsApp Business Account into this workspace.',
        detail:
          'Until a number is connected, no conversation can reach your inbox. Meta hosts the connection — you approve it in their window and come straight back here.',
        action: 'Connect WhatsApp',
      },
      invite_agents: {
        title: 'Invite your agents',
        summary: 'Give the people who will answer customers a way in.',
        detail:
          'Everyone you invite gets an email with their own sign-in. You can set who is an agent and who supervises now, and change it later.',
        action: 'Invite people',
      },
      set_branding: {
        title: 'Set your branding',
        summary: 'Put your own name, logo and colours on the console.',
        detail:
          'Branding decides what your team and your customers see instead of the default product name and colours.',
        action: 'Set branding',
      },
    } satisfies Record<
      OnboardingStepId,
      { title: string; summary: string; detail: string; action: string }
    >,

    /**
     * Said plainly rather than shown as a link to a page that does not exist yet.
     * TAR-29 owns the branding editor; skipping is the honest option until it lands.
     */
    unavailableNotice:
      'The branding editor is not built yet. Skip this for now — it will appear here when it lands.',

    /**
     * Shown above the list rather than instead of it: a step that was skipped is
     * still on the list, and replacing it with a congratulation would take away
     * the way back that TAR-36 asks for.
     */
    completeNotice:
      'Nothing is outstanding — your workspace is set up. Anything you skipped is still below if you want to come back to it.',

    unavailableHeading: 'We could not load your checklist',
    unavailableBody:
      'Your workspace is fine — only this list failed to load. Try again, and everything you have already set up is still set up.',
  },

  /**
   * The workspace settings surface (TAR-409): profile, plan state and seat
   * usage.
   *
   * *Workspace*, never *organisation* or *tenant*. `docs/STYLE.md` fixes
   * *tenant* as the internal word and *workspace* as the only one the console
   * says on screen, and every other string in this file already honours it.
   */
  workspace: {
    title: 'Workspace',
    subtitle: 'Your workspace profile, plan and seat usage.',
    loading: 'Loading workspace settings',

    // --- Profile -----------------------------------------------------------
    profileHeading: 'Workspace profile',
    profileDescription: 'The name and support address your team and your customers see.',
    nameLabel: 'Workspace name',
    nameRequiredError: 'Enter a workspace name',
    nameTooLongError: (max: number) => `Use ${max} characters or fewer`,
    supportEmailLabel: 'Support email address',
    supportEmailHint:
      'Where customers are told to write when they need a human. Leave it blank if you do not have one yet.',
    supportEmailEmpty: 'Not set',
    addressLabel: 'Workspace address',
    /**
     * The slug is immutable by contract — it is baked into the platform
     * subdomain and into every session cookie scoped to that host — so the
     * field is shown as text rather than as a disabled input, and says why.
     */
    addressHint: 'Fixed when the workspace was created. Changing it would break every saved link.',
    addressEmpty: 'Not assigned yet',
    saveProfile: 'Save changes',
    profileSavedToast: 'Workspace profile saved',
    profileReadOnlyNotice:
      'Your role can read these details but not change them. Ask a workspace admin.',

    // --- Branding ----------------------------------------------------------
    brandingHeading: 'Branding',
    brandingDescription: 'How this workspace is presented to your customers.',
    brandingProductName: 'Product name',
    brandingPrimaryColour: 'Primary colour',
    brandingAccentColour: 'Accent colour',
    brandingLogo: 'Logo',
    brandingLogoEmpty: 'Not uploaded',
    /**
     * Said plainly rather than left as a control that does nothing. TAR-29 owns
     * the editor; these values are set at provisioning until it lands, and a
     * page that showed a colour picker writing to no endpoint would be worse
     * than one that admits the gap.
     */
    brandingPendingNotice:
      'The branding editor — logo, favicon and colours — arrives with the white-labelling work. Until then these are set when the workspace is provisioned.',

    // --- Plan and usage ----------------------------------------------------
    planHeading: 'Plan and usage',
    planDescription: 'What this workspace is entitled to, and how much of it is in use.',
    planLabel: 'Plan',
    statusLabel: 'Status',
    trialEndsLabel: 'Trial ends',
    /** When a `past_due` or `cancelled` workspace becomes suspended. */
    suspendsLabel: 'Suspends',
    purgeLabel: 'Data deleted',

    seatsHeading: 'Agent seats',
    seatsUsage: (used: string, cap: string) => `${used} of ${cap} seats in use`,
    seatsUsageUnlimited: (used: string) => `${used} seats in use — this plan sets no limit`,
    seatsPendingNote: (pending: number) =>
      pending === 1
        ? '1 invitation is outstanding and counts against the cap.'
        : `${pending} invitations are outstanding and count against the cap.`,
    seatsAtCapNote: 'Every seat is taken. Remove an agent before inviting anyone else.',
    /**
     * The at-cap line when some of those seats are invitations nobody has
     * accepted. It has to name them: withdrawing one is the cheapest way to free
     * a seat, and "5 of 5 seats in use" on its own hides that there is anything
     * to withdraw.
     */
    seatsAtCapPendingNote: (pending: number) =>
      pending === 1
        ? 'Every seat is taken, and one of them is an invitation nobody has accepted yet. Withdraw it, or remove an agent, before inviting anyone else.'
        : `Every seat is taken, and ${pending} of them are invitations nobody has accepted yet. Withdraw one, or remove an agent, before inviting anyone else.`,

    conversationsHeading: 'Conversations this period',
    conversationsUsage: (used: string, cap: string) => `${used} of ${cap} conversations`,
    conversationsUsageUnlimited: (used: string) =>
      `${used} conversations — this plan sets no limit`,

    /**
     * A cap has been reached. TAR-37 replaced ADR 0009 risk 4's "contact
     * support" with a real checkout, so this now names the page that raises the
     * limit rather than an email address that cannot.
     */
    upgradeUnavailableNotice: 'A limit has been reached. Compare plans to raise it.',
    upgradeLink: 'Plans and billing',

    /**
     * One line per lifecycle state, so a badge never carries meaning alone.
     *
     * `created` is written for a reader who should never see it. A workspace is
     * only in that state between its row appearing and provisioning finishing,
     * both inside one transaction, and the host guard answers `tenant_not_found`
     * for it — so rendering this string means provisioning stopped halfway. The
     * copy says the true thing for that case rather than naming the internal
     * state, because "Created" would read as finished to the one person unlucky
     * enough to be looking at it.
     */
    statuses: {
      created: 'Setting up',
      trialing: 'Trial',
      active: 'Active',
      past_due: 'Payment overdue',
      suspended: 'Suspended',
      cancelled: 'Closing',
      deleted: 'Deleted',
    } satisfies Record<TenantStatus, string>,

    statusDescriptions: {
      created: 'This workspace is still being set up and is not ready yet.',
      trialing: 'Everything is available while the trial runs.',
      active: 'Everything is available.',
      past_due: 'Everything still works. A payment has not gone through.',
      suspended: 'Agents cannot sign in. Nothing has been deleted.',
      cancelled: 'This workspace is closing. Everything still works until it does.',
      deleted: 'This workspace and its data have been deleted.',
    } satisfies Record<TenantStatus, string>,

    // --- Lifecycle banners --------------------------------------------------
    /**
     * `cancelled` gets a banner alongside the two TAR-409 names. A cancelled
     * workspace is counting down to suspension and then to deletion, and
     * leaving that silent would be exactly the failure the other two banners
     * exist to prevent.
     */
    banners: {
      past_due: {
        heading: 'A payment has not gone through',
        body: 'Nothing has changed yet — your team can still work as normal. If the payment does not succeed, this workspace is suspended and agents lose access.',
      },
      suspended: {
        heading: 'This workspace is suspended',
        body: 'Agents cannot sign in. Messages your customers send are still received and stored, and nothing has been deleted. Settle the outstanding payment to restore access.',
      },
      cancelled: {
        heading: 'This workspace is closing',
        body: 'Your team can still work as normal until it closes. Contact support if you want to keep it.',
      },
    },
  },

  /**
   * Plans, usage and billing (TAR-37, TAR-619).
   *
   * Two rules shape most of the copy here, and both are about not overclaiming:
   *
   *   1. **Never announce a payment the API has not confirmed.** The redirect
   *      back from the hosted checkout page beats the provider's webhook more
   *      often than not, so "you paid" and "your plan changed" are two different
   *      sentences and only the second is read off the subscription.
   *   2. **Never state a limit the console worked out for itself.** Whether a
   *      plan can be selected, and which ceiling blocks it, are answered by the
   *      API — `isSelectable` and `blockedBy` — because they depend on live
   *      usage. The copy phrases that answer; it does not derive one.
   */
  billing: {
    title: 'Plans and billing',
    subtitle: 'What this workspace is on, what it is using, and where to change it.',
    loading: 'Loading plans and billing',

    // --- Current plan ------------------------------------------------------
    currentHeading: 'Current plan',
    currentDescription: 'Your plan, its allowances, and how much of each is in use.',
    planLabel: 'Plan',
    statusLabel: 'Status',
    seatsLabel: 'Seats billed',
    renewsLabel: 'Renews',
    endsLabel: 'Ends',
    trialEndsLabel: 'Trial ends',
    priceLabel: 'Price',
    /**
     * What a price is *per*, as one phrase rather than two joined with a space.
     *
     * `Intl` formats the amount and the content layer phrases the rest, and the
     * rest is a single unit: a translation may well not put "per seat" and "per
     * month" in that order, or use two prepositions at all, and two keys
     * concatenated at the call site cannot follow it.
     */
    seatCadence: {
      month: 'per seat, per month',
      year: 'per seat, per year',
    } satisfies Record<'month' | 'year', string>,

    /**
     * One line per provider-neutral subscription state. `canceled` is the
     * contract's spelling of the *state*, and the copy for it is deliberately
     * reassuring: a cancellation that has been requested is still paid for, and
     * telling somebody they have lost access on the day they clicked cancel
     * would be false as well as alarming.
     */
    statuses: {
      trialing: 'Trial',
      active: 'Active',
      past_due: 'Payment overdue',
      canceled: 'Closing at the end of this period',
      incomplete: 'Waiting for payment',
    } satisfies Record<SubscriptionStatus, string>,

    /**
     * No subscription is the normal state for a workspace on trial, not a
     * failure — and it is not an *empty* card either, because the two usage
     * meters below it are populated with real numbers. So it is one line of
     * plain statement rather than the empty-state anatomy it used to wear
     * (TAR-711): the card is not empty, the plan is unset, and those are
     * different sentences.
     */
    noSubscriptionNotice:
      'This workspace is on its trial allowances. Nothing is charged until you choose a plan.',
    /** Jumps to the plans section on the same page (TAR-515). */
    noSubscriptionAction: 'See the plans',

    seatsHeading: 'Agent seats',
    seatsUsage: (used: string, cap: string) => `${used} of ${cap} seats in use`,
    seatsUsageUnlimited: (used: string) => `${used} seats in use — this plan sets no limit`,
    seatsPendingNote: (pending: number) =>
      pending === 1
        ? '1 invitation is outstanding and counts against the cap.'
        : `${pending} invitations are outstanding and count against the cap.`,
    conversationsHeading: 'Conversations this period',
    conversationsUsage: (used: string, cap: string) => `${used} of ${cap} conversations`,
    conversationsUsageUnlimited: (used: string) =>
      `${used} conversations — this plan sets no limit`,

    // --- Plans -------------------------------------------------------------
    plansHeading: 'Plans',
    plansDescription: 'Every tier, what it allows, and what it unlocks.',
    plansEmptyHeading: 'No plans are available',
    plansEmptyBody:
      'No plan is on sale for this workspace right now. Contact support and they can put one in place for you.',
    /**
     * The copy instructs "contact support", so the state offers it (TAR-515).
     * Only rendered where `NEXT_PUBLIC_SUPPORT_EMAIL` is configured — the same
     * rule the WhatsApp panel follows, for the same reason.
     */
    plansEmptySupportAction: 'Contact support',
    plansEmptySupportSubject: 'Put a plan in place for our workspace',
    currentPlanBadge: 'Current plan',
    currentPlanAction: 'Your current plan',
    choosePlan: (planName: string) => `Choose ${planName}`,
    allowancesHeading: 'Allowances',
    allowanceSeats: (cap: string) => `${cap} agent seats`,
    allowanceSeatsUnlimited: 'Unlimited agent seats',
    allowanceConversations: (cap: string) => `${cap} conversations per period`,
    allowanceConversationsUnlimited: 'Unlimited conversations',
    featuresHeading: 'Includes',
    /** One line per `PlanFeature`, in the words a buyer uses rather than the key. */
    features: {
      assignment_rules: 'Automatic routing rules',
      sla_policies: 'SLA policies and breach alerts',
      workflows: 'Workflow automation',
      ai_chatbot: 'AI chatbot and knowledge base',
      custom_branding: 'Your own logo and colours',
      custom_domain: 'Your own domain',
      advanced_reporting: 'Advanced reporting',
      api_access: 'API access',
    } satisfies Record<PlanFeature, string>,
    noFeatures: 'The essentials: shared inbox, contacts and tickets.',

    /**
     * Why a plan cannot be chosen, phrased from the API's `blockedBy` rather
     * than worked out here. A downgrade below current usage is refused *before*
     * checkout, so the sentence has to say what to change — otherwise the button
     * is simply dead.
     *
     * Rendered directly beneath the control it explains and wired to it with
     * `aria-describedby` (TAR-711), so it reads as this button's reason rather
     * than as a warning floating above the plan.
     */
    blockedBy: {
      seats:
        'This plan has fewer seats than you are using. Remove an agent or withdraw an invitation first.',
      conversationsPerPeriod:
        'You have already had more conversations this period than this plan allows.',
    } satisfies Record<'seats' | 'conversationsPerPeriod', string>,

    checkoutPending: 'Opening checkout',
    checkoutFailed: 'We could not open the checkout page. Try again in a moment.',
    /**
     * The pending state needs designing rather than assuming the redirect always
     * lands (TAR-711). The browser is on its way to somebody else's origin and
     * the button stays pending through the navigation, so this says what the
     * wait is for and why the other tiers stopped responding.
     */
    checkoutRedirectNote: 'Taking you to our payment provider — this page stays open.',

    // --- Returning from checkout -------------------------------------------
    /**
     * Three outcomes, not two. `confirming` is the honest one: the provider sent
     * the browser back but its webhook has not landed, so the plan on screen is
     * still the old one and saying anything else would be a guess about money.
     */
    outcome: {
      confirmingHeading: 'Confirming your payment',
      confirmingBody:
        'Your payment went through and we are waiting for the provider to confirm it. This usually takes a few seconds — refresh the page to check.',
      confirmingAction: 'Refresh',
      succeededHeading: 'Your plan is active',
      succeededBody: (planName: string) =>
        `This workspace is on ${planName}. The new allowances apply from now.`,
      cancelledHeading: 'Checkout cancelled',
      cancelledBody: 'Nothing was charged and your plan has not changed.',
    },

    // --- Portal ------------------------------------------------------------
    portalHeading: 'Invoices and payment',
    portalDescription:
      'Invoices, payment method, changing your plan and cancelling are all handled by our payment provider.',
    portalBody:
      'You are taken to the provider’s own secure portal, signed in as this workspace. Card details are never handled by us.',
    portalAction: 'Open the billing portal',
    portalPending: 'Opening the portal',
    portalFailed: 'We could not open the billing portal. Try again in a moment.',
    /** A portal session needs a subscription to be a portal *for*. */
    portalUnavailableNotice:
      'The billing portal opens once this workspace is on a paid plan. Choose one below to get started.',

    readOnlyNotice: 'Your role can see the plan and its usage, but not change it. Ask an admin.',

    // --- Banners -----------------------------------------------------------
    /**
     * The volume warning. Two states, because "you are close" and "you are over"
     * are different messages and only the second one is urgent — and neither
     * ever claims a message was blocked, because the platform's default policy
     * is to warn rather than block (`VOLUME_POLICIES`).
     */
    volumeBanner: {
      approachingHeading: 'You are close to your conversation allowance',
      approachingBody: (used: string, cap: string) =>
        `${used} of ${cap} conversations for this period. Nothing has changed yet — move to a larger plan if you expect to keep going at this rate.`,
      reachedHeading: 'You have used your conversation allowance',
      reachedBody: (used: string, cap: string) =>
        `${used} of ${cap} conversations for this period. Your customers’ messages are still received, and your allowance resets when the period does.`,
      action: 'Compare plans',
    },

    /**
     * A requested cancellation. Its whole job is to say that nothing has been
     * lost yet — the provider reports a cancellation the moment it is asked for,
     * and the workspace stays fully usable until the date below.
     */
    cancellationBanner: {
      heading: 'This plan is set to close',
      body: 'Everything keeps working as normal until then. Reopen the billing portal if you want to keep the plan.',
      dateLabel: 'Closes',
    },
  },

  /**
   * White-label branding (TAR-29). The copy an admin reads while changing what
   * every other person in the tenant sees, so it says what each choice affects
   * and where it will show up.
   */
  branding: {
    title: 'Branding',
    subtitle: 'Your logo, colours and product name, across the console and the sign-in screen.',
    loading: 'Loading branding',

    identityHeading: 'Identity',
    identityDescription: 'What this workspace is called, and where people write for help.',
    productNameLabel: 'Product name',
    productNameHint:
      'Replaces the platform name in the console, the sign-in screen and the browser tab.',
    supportEmailLabel: 'Support email',
    supportEmailHint: 'Shown to your agents when something needs a human. Leave empty to hide it.',

    coloursHeading: 'Colours',
    coloursDescription:
      'The primary colour carries every action. The decorative colour is used for backdrops and highlights only, never behind text.',
    primaryColorLabel: 'Primary colour',
    primaryColorHint: 'Buttons, links, focus rings and the current-page marker.',
    accentColorLabel: 'Decorative colour',
    accentColorHint:
      'Backdrops and highlights. Never used behind text, so it is not contrast-checked.',
    hexLabel: (label: string) => `${label} hex value`,
    /**
     * Reported rather than enforced. Every text pair the console derives is
     * corrected to clear AA automatically, so a low-contrast pick is a taste
     * problem, not a broken screen — and telling an admin their colour scored
     * 2.1:1 is more useful than silently changing it.
     */
    contrastScore: (ratio: string) => `${ratio}:1 against its own text`,
    contrastPasses: 'Meets WCAG AA',
    contrastAdjusted: 'Text on this colour is adjusted automatically to stay readable',
    resetColours: 'Reset to the default colours',

    // --- Field-level refusals ------------------------------------------------
    productNameRequired: 'Give this workspace a name',
    productNameTooLong: (max: number) => `Use ${max} characters or fewer`,
    supportEmailInvalid: 'Enter an email address, or leave it empty',
    colorInvalid: 'Use a six-digit hex colour, like #067a52',

    previewHeading: 'Preview',
    previewDescription: 'Live, and exactly what the console will use once you save.',
    previewButton: 'Primary action',
    previewSecondaryButton: 'Secondary',
    previewBadge: 'Highlight',
    previewLinkText: 'A link in running text',
    previewBodyText: 'Body text stays on the platform palette — only the accent family is yours.',

    assetsHeading: 'Logo and favicon',
    assetsDescription: 'PNG, JPEG or WebP. SVG is not accepted, because an SVG can carry script.',
    logoLabel: 'Logo',
    logoHint: 'Shown in the navigation rail, the mobile top bar and above the sign-in form.',
    faviconLabel: 'Favicon',
    faviconHint: 'The small icon in a browser tab.',
    assetAlt: (productName: string) => `${productName} logo`,
    chooseFile: (label: string) => `Choose a new ${label.toLowerCase()}`,
    removeAsset: (label: string) => `Remove ${label.toLowerCase()}`,
    noAsset: 'Nothing uploaded — the product name is shown instead.',
    assetMeta: (size: string, updated: string) => `${size} · updated ${updated}`,
    /** Checked in the browser before the upload is spent; the API checks again. */
    tooLarge: (label: string, limit: string) => `That ${label.toLowerCase()} is over ${limit}.`,
    wrongType: (label: string, types: string) =>
      `That ${label.toLowerCase()} is not a supported image. Use ${types}.`,
    uploading: 'Uploading',
    uploadedToast: (label: string) => `${label} updated`,
    removedToast: (label: string) => `${label} removed`,
    savedToast: 'Branding saved',
    removeConfirmTitle: (label: string) => `Remove the ${label.toLowerCase()}?`,
    removeConfirmBody: (label: string) =>
      `The ${label.toLowerCase()} disappears from every screen in this workspace immediately. You can upload a new one at any time.`,
    removeConfirm: 'Remove',
  },

  /**
   * Custom domains (TAR-29). Every string here is read by somebody who is about
   * to edit DNS, so the records are quoted exactly and the states say what is
   * true rather than what we hope.
   */
  domains: {
    title: 'Domains',
    subtitle: 'The addresses this workspace answers on.',
    loading: 'Loading domains',

    listHeading: 'Your domains',
    listDescription:
      'Your platform subdomain always works. Add your own hostname to serve the console from it.',
    emptyHeading: 'No custom domain yet',
    emptyBody:
      'Add a hostname you control — support.example.com — and we will show you the DNS records to add.',

    addButton: 'Add a domain',
    addTitle: 'Add a domain',
    hostnameLabel: 'Hostname',
    hostnameHint: 'A hostname you control, without https:// — for example support.example.com.',
    addSubmit: 'Add domain',
    addedToast: (hostname: string) => `${hostname} added — add the DNS records to verify it`,

    statusLabel: 'Status',
    statuses: {
      pending_verification: 'Awaiting DNS',
      verified: 'Verified',
      live: 'Live',
      expired: 'Claim expired',
    } satisfies Record<TenantDomainStatus, string>,
    statusDescriptions: {
      pending_verification:
        'Add the TXT record below, then check again. DNS changes can take up to an hour to appear.',
      verified:
        'Ownership is proved. We are attaching the certificate — the domain starts serving traffic once that finishes.',
      live: 'Serving traffic with a certificate.',
      expired:
        'This claim was not verified in time and has been released. Remove it and add the hostname again to start over.',
    } satisfies Record<TenantDomainStatus, string>,
    kinds: {
      platform: 'Platform subdomain',
      custom: 'Custom domain',
    } satisfies Record<TenantDomainKind, string>,
    primaryBadge: 'Primary',
    primaryExplanation: 'Invite and password-reset links are sent to the primary domain.',

    verificationHeading: 'Step 1 — prove you own it',
    verificationBody: 'Add this TXT record at your DNS provider, then check again.',
    routingHeading: 'Step 2 — point it at us',
    routingBody: 'Once verified, add this record so traffic reaches the console.',
    recordType: 'Type',
    recordName: 'Name',
    recordValue: 'Value',
    copyRecord: (field: string) => `Copy the ${field.toLowerCase()}`,
    copiedToast: 'Copied',
    lastCheckedLabel: 'Last checked',
    neverChecked: 'Not checked yet',
    /** Followed by a relative time, so the claim's deadline is never a bare date. */
    expiresLabel: 'Unverified claim released',

    failureReasons: {
      record_not_found:
        'We could not find that TXT record yet. DNS changes can take up to an hour.',
      record_mismatch:
        'A TXT record exists at that name but its value does not match. Check for a typo or an old record.',
      lookup_failed: 'We could not reach that domain’s nameservers. We will keep trying.',
      lookup_timeout: 'The DNS lookup timed out. We will keep trying.',
    } satisfies Record<DomainVerificationFailureReason, string>,

    verifyButton: 'Check DNS',
    verifiedToast: (hostname: string) => `${hostname} is verified`,
    stillPendingToast: (hostname: string) => `${hostname} is not verified yet`,

    setPrimaryButton: 'Make primary',
    setPrimaryToast: (hostname: string) => `${hostname} is now the primary domain`,

    removeButton: 'Remove',
    removeConfirmTitle: (hostname: string) => `Remove ${hostname}?`,
    removeConfirmBody:
      'The console stops answering on this hostname immediately, and anyone using it gets an error until you point them somewhere else. Your platform subdomain is unaffected.',
    removePrimaryWarning:
      'This is the primary domain, so invite and password-reset links move back to your platform subdomain.',
    removeConfirm: 'Remove domain',
    removedToast: (hostname: string) => `${hostname} removed`,
    /** The platform subdomain is the tenant's floor and can never be deleted. */
    platformNotRemovable:
      'Your platform subdomain cannot be removed — it is how you always reach the console.',
    limitReached: (limit: number) => `You can have up to ${limit} custom domains.`,
  },

  /**
   * The AI chatbot (TAR-28): the knowledge base an admin writes, the settings
   * that decide when the bot answers, and why it is or is not answering today.
   *
   * The vocabulary is fixed here and nowhere else. `docs/STYLE.md` reserves
   * *agent* for a person, so the machine is only ever **the chatbot** or **the
   * bot** on screen — never "the agent", and never "AI agent".
   */
  chatbot: {
    title: 'Chatbot',
    subtitle: 'What the chatbot knows, and when it answers instead of your team.',
    loading: 'Loading chatbot settings',

    // --- Readiness ---------------------------------------------------------
    readinessHeading: 'Automated replies',
    readinessDescription: 'Whether the chatbot is answering customers right now.',
    /**
     * The readiness badge, and deliberately not `enabledOn` / `enabledOff`
     * (TAR-710). Those two words belong to the switch in the settings card and
     * to nothing else: a badge reading "On" beside a control reading "On" made
     * one boolean look like two, and readiness is not that boolean anyway — it
     * is the conjunction of four clauses, of which the switch is one.
     */
    readinessOn: 'Answering',
    readinessOff: 'Not answering',
    readyHeading: 'The chatbot is answering',
    readyBody: (indexedCount: number) =>
      indexedCount === 1
        ? 'It answers from 1 indexed entry, and passes anything it is unsure about to your team.'
        : `It answers from ${indexedCount} indexed entries, and passes anything it is unsure about to your team.`,
    notReadyHeading: 'The chatbot is not answering',
    notReadyBody:
      'Every conversation goes straight to your team, exactly as it did before. Clear the following to switch automated replies on:',
    /**
     * One line per clause of the KB-ready rule, and every failing one is shown
     * rather than only the first. An admin who fixes one of four and still gets
     * silence has learned nothing.
     *
     * `no_indexed_documents` is TAR-28's third acceptance criterion said out
     * loud: an empty knowledge base means the chatbot stays quiet, and the
     * console has to say so rather than leaving a switch that looks on.
     */
    blockers: {
      provider_not_configured:
        'The AI provider is not configured on this platform. Only the platform operator can change that — contact support.',
      feature_not_in_plan: 'The chatbot is not included in this workspace’s plan.',
      disabled: 'The chatbot is switched off below.',
      no_indexed_documents:
        'The knowledge base is empty, so there is nothing to answer from. Add an entry and index it — the chatbot never invents an answer.',
    } satisfies Record<AiReadinessBlocker, string>,

    // --- Configuration -----------------------------------------------------
    settingsHeading: 'Chatbot settings',
    settingsDescription: 'When the chatbot replies, and when it hands over.',
    enabledLabel: 'Answer customers automatically',
    enabledHint:
      'Switch this off to send every conversation to your team without changing anything else here.',
    enabledOn: 'On',
    enabledOff: 'Off',
    modelLabel: 'Model',
    modelHint:
      'A faster model costs less per reply and is less careful about what it does not know.',
    modelDefaultOption: (name: string) => `Use the recommended model (${name})`,
    /**
     * The empty choice when the API published no recommended model — a state
     * that should not happen. Its own string rather than the entry editor's
     * "Not set": these two read the same today and are not the same sentence,
     * and one of them will need to change without the other.
     */
    modelDefaultUnavailable: 'No recommended model',
    /** Rendered from the prices the API publishes — never from copy. */
    modelPrice: (input: string, output: string) =>
      `${input} in · ${output} out, per million tokens`,
    confidenceLabel: 'Confidence needed to reply',
    confidenceHint:
      'Both the search and the model have to be at least this sure. Raise it to hand over more often; lower it to let the chatbot answer more.',
    confidenceValue: (percent: string) => `${percent} sure`,
    maxTurnsLabel: 'Replies before handing over',
    maxTurnsHint:
      'The most the chatbot answers in one conversation before a person takes it, however confident it is.',
    /**
     * Says what a valid answer looks like rather than what was wrong with this
     * one. An emptied number field and a half-typed one are the same value to
     * the browser, so one message has to serve both.
     */
    maxTurnsInvalidError: (min: number, max: number) =>
      `Enter a whole number between ${min} and ${max}`,
    systemPromptLabel: 'How the chatbot should sound',
    systemPromptHint:
      'Tone and house rules. It never overrides the knowledge base — the chatbot answers only from what you have written there.',
    handoffKeywordsLabel: 'Words that ask for a person',
    handoffKeywordsHint:
      'Any message containing one of these hands over immediately, before the chatbot looks anything up. Enter one per line.',
    handoffKeywordsPlaceholder: 'agent\nhuman\nperson',
    handoffKeywordTooLongError: (max: number) => `Keep each word to ${max} characters or fewer`,
    handoffKeywordsTooManyError: (max: number) => `Use ${max} words or fewer`,
    handoffMessageLabel: 'What the customer is told on handover',
    handoffMessageHint:
      'Sent once per conversation when the chatbot gives up. Leave it blank to say nothing.',
    saveSettings: 'Save changes',
    settingsSavedToast: 'Chatbot settings saved',
    settingsReadOnlyNotice:
      'Your role can read these settings but not change them. Ask a workspace admin.',
    upsellNotice:
      'The chatbot is not included in this workspace’s plan. These settings are read-only until it is.',

    // --- Knowledge base ----------------------------------------------------
    knowledgeHeading: 'Knowledge base',
    knowledgeDescription: 'What the chatbot is allowed to answer from. Nothing else.',
    knowledgeLoading: 'Loading knowledge base entries',
    addEntry: 'Add entry',
    knowledgeEmptyHeading: 'Nothing in the knowledge base yet',
    /**
     * The empty state carries TAR-28's AC3 rather than only saying "no rows":
     * with nothing here the chatbot stays silent, and an admin who does not know
     * that reads the empty table as a feature that is broken.
     */
    knowledgeEmptyBody:
      'The chatbot answers only from entries you add here, so until there is one it stays quiet and every conversation goes to your team. Add your returns policy, your delivery times, your opening hours.',
    /**
     * Said rather than paged. The list is keyset-paginated and a second page is
     * a real feature; until it exists, naming how many are shown is honest, and
     * a pager that could not page would not be. TAR-613 is the follow-up.
     */
    knowledgeShowingFirst: (count: number) =>
      `Showing the ${count} most recent entries. The chatbot searches every entry, not only these.`,

    columnTitle: 'Title',
    columnStatus: 'Status',
    columnChunks: 'Indexed pieces',
    columnUpdated: 'Updated',
    columnActions: 'Actions',
    updatedAt: 'Updated',

    statuses: {
      pending: 'Indexing',
      indexed: 'Ready',
      failed: 'Failed',
    } satisfies Record<KnowledgeDocumentStatus, string>,
    statusDescriptions: {
      pending: 'Being split for search. The chatbot cannot use it yet.',
      indexed: 'The chatbot can answer from this.',
      failed: 'It could not be indexed, so the chatbot ignores it.',
    } satisfies Record<KnowledgeDocumentStatus, string>,
    chunkCount: (count: number) => (count === 1 ? '1 piece' : `${count} pieces`),
    chunkCountEmpty: 'None yet',

    // --- The entry editor --------------------------------------------------
    createTitle: 'Add a knowledge base entry',
    createDescription:
      'Write it the way you would explain it to a customer. Separate topics with a blank line — each becomes a piece the chatbot can find on its own.',
    createSubmit: 'Add entry',
    createSuccess: (title: string) => `“${title}” added — indexing now`,
    editTitle: 'Edit knowledge base entry',
    editDescription:
      'Changing the text re-indexes the entry, and the chatbot stops using it until that finishes.',
    editSubmit: 'Save entry',
    editSuccess: (title: string) => `“${title}” saved`,
    editEntry: 'Edit',
    editEntryAria: (title: string) => `Edit ${title}`,
    /**
     * The list omits every entry's text — a page of them, each up to 256 KiB, is
     * a response nobody wants — so the editor fetches the one it is opening.
     */
    editLoading: 'Loading this entry',
    editLoadFailed: 'That entry could not be loaded, so it cannot be edited yet.',
    editLoadRetry: 'Try again',
    entryTitleLabel: 'Title',
    entryTitlePlaceholder: 'Returns and refunds policy',
    entryTitleTooLongError: (max: number) => `Use ${max} characters or fewer`,
    entryContentLabel: 'What the chatbot should know',
    entryContentPlaceholder:
      'Unopened items can be returned within 30 days of delivery for a full refund.',
    entryContentTooLongError: 'That entry is too long. Split it into two.',
    entrySourceUrlLabel: 'Where this came from',
    entrySourceUrlHint: 'A link for your own team. The customer never sees it.',
    entrySourceUrlInvalidError: 'Enter a full web address, starting with https://',
    entryLanguageLabel: 'Language',
    entryLanguageHint: 'For your own team. Search works the same whichever you pick.',
    entryLanguageUnset: 'Not set',

    // --- Reindexing and deleting -------------------------------------------
    reindex: 'Index again',
    reindexAria: (title: string) => `Index ${title} again`,
    reindexSuccess: (title: string) => `“${title}” is being indexed again`,
    indexFailedLabel: 'Why it failed',
    deleteEntry: 'Delete',
    deleteEntryAria: (title: string) => `Delete ${title}`,
    /**
     * A confirmation names the thing it is about to destroy, in its title as
     * well as in its body (0001, TAR-709). "Are you sure?" over a table of
     * near-identical rows asks the reader to remember which one they clicked.
     */
    deleteTitle: (title: string) => `Delete “${title}”?`,
    deleteBody: (title: string) =>
      `“${title}” is removed from the knowledge base and the chatbot stops answering from it. This cannot be undone.`,
    /**
     * The one warning worth interrupting for: deleting the last entry silently
     * switches automated replies off, and an admin who did not know that would
     * read the quiet inbox as a fault.
     */
    deleteLastBody: (title: string) =>
      `“${title}” is the only entry the chatbot can answer from. Deleting it stops automated replies altogether, and every conversation goes to your team. This cannot be undone.`,
    deleteConfirm: 'Delete entry',
    deleteSuccess: (title: string) => `“${title}” deleted`,
  },

  auth: {
    // --- Shared ------------------------------------------------------------
    emailLabel: 'Email address',
    currentPasswordLabel: 'Current password',
    newPasswordLabel: 'New password',
    confirmPasswordLabel: 'Confirm new password',
    /**
     * Length only, deliberately. The contract follows current NIST guidance and
     * asks for a floor rather than character classes, so promising rules the API
     * does not enforce would just cost people a failed submit.
     */
    passwordHint: (minLength: number) =>
      `At least ${minLength} characters. A long phrase beats a short puzzle.`,
    backToSignIn: 'Back to sign in',
    forgotPasswordLink: 'Forgot your password?',
    requestNewLink: 'Request a new link',
    genericFailure: 'We could not complete that. Try again in a moment.',
    /**
     * The reveal control inside a password input (TAR-521). Two strings rather
     * than one plus a pressed state: the control's accessible name has to say
     * what pressing it will do *now*, and "Show password" announced while the
     * password is already on screen is the wrong sentence.
     */
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    /** Names the requirement checklist for a screen reader; nothing shows it. */
    passwordRequirementsLabel: 'Password requirements',
    /**
     * The checklist beside a new password, derived from `AUTH_POLICY` for the
     * same reason `passwordHint` is: a rule written down here and enforced there
     * is a rule that will disagree with itself.
     */
    passwordMinRequirement: (minLength: number) => `At least ${minLength} characters`,
    passwordMaxRequirement: (maxLength: number) => `At most ${maxLength} characters`,
    /**
     * The one line of positioning on the sign-in screen's brand panel.
     *
     * **Placeholder.** TAR-521 puts the slot on the page and says explicitly that
     * the wording is a Product Owner call; it is deliberately about the job the
     * console does rather than about any one workspace, because a tenant's own
     * name is what renders above it.
     */
    brandTagline: 'Every customer conversation your team handles, in one place.',
    /** The auth screens' footer line out to whoever runs this deployment. */
    supportLink: 'Contact support',
    supportSubject: 'Help signing in',

    // --- Session ------------------------------------------------------------
    signOut: 'Sign out',

    // --- Sign in -----------------------------------------------------------
    signInTitle: 'Sign in',
    signInDescription: 'Use the email address your workspace invited.',
    signInSubmit: 'Sign in',
    /**
     * What the submit button says while the request is in flight (TAR-521). One
     * per flow rather than a shared "Submitting…": on a screen whose fields have
     * just been disabled, the button is the only thing saying what is happening.
     */
    signInPending: 'Signing in…',
    signInSuccess: (displayName: string) => `Signed in as ${displayName}`,
    passwordLabel: 'Password',
    /**
     * The API answers `invalid_credentials` for a wrong password, an unknown
     * address and a suspended account alike, precisely so login cannot be used to
     * find out which addresses exist. This line must not undo that by hinting.
     */
    invalidCredentialsError: 'That email address and password do not match',
    /** A lockout arrives as `rate_limited`; the wait comes from `AUTH_POLICY`. */
    lockedOutError: (minutes: number) =>
      `Too many failed sign-in attempts. Try again in ${minutes} minutes, or ask an admin to unlock the account.`,
    workspaceInactiveError: 'This workspace is not active. Contact your administrator.',
    workspaceNotFoundError: 'This address is not set up for a workspace. Check the link you used.',
    signInFailedError: 'We could not sign you in. Try again.',

    // --- Accept an invitation ----------------------------------------------
    inviteTitle: 'Accept your invitation',
    inviteDescription: 'Set a password to finish creating your account.',
    inviteLoading: 'Opening your invitation',
    invitedByTo: (inviter: string, workspace: string) =>
      `${inviter} invited you to join ${workspace}.`,
    /** The platform-issued bootstrap invite has no inviting user to name. */
    invitedTo: (workspace: string) => `You have been invited to join ${workspace}.`,
    inviteExpiryLabel: 'Invitation expires',
    inviteExpires: 'Expires',
    inviteRoleLabel: 'Role',
    inviteDisplayNameLabel: 'Your name',
    inviteDisplayNameHint: 'Teammates see this on the conversations you handle.',
    inviteDisplayNameRequiredError: 'Enter your name',
    inviteDisplayNameTooLongError: 'That name is too long. Use a shorter one.',
    invitePasswordLabel: 'Choose a password',
    inviteSubmit: 'Create account',
    invitePending: 'Creating your account…',
    inviteSuccess: (workspace: string) => `Welcome to ${workspace}`,
    inviteFailedError: 'We could not create your account. Try again.',
    inviteAccountExistsError:
      'There is already an account for this address in this workspace. Sign in instead.',
    inviteUnusableHeading: 'This invitation link cannot be used',
    inviteIncompleteBody:
      'The link is missing its token, which usually means it was truncated on the way to you. Open the invitation email again, without editing the address.',
    inviteDeadLinkBody:
      'It may have expired, already been used, or been withdrawn. Ask a workspace admin to send you a new one.',

    // --- Forgot password ---------------------------------------------------
    forgotTitle: 'Reset your password',
    forgotDescription:
      'Enter the address you sign in with and we will email you a link to set a new password.',
    forgotSubmit: 'Email me a reset link',
    forgotPending: 'Sending your link…',
    forgotSentHeading: 'Check your email',
    /**
     * Says "if an account exists" and never confirms it does. The API answers
     * identically for a real address, an unknown one and a throttled request, and
     * this screen must not undo that by wording the two cases differently.
     */
    forgotSentBody: (email: string) =>
      `If an account exists for ${email}, a link to set a new password is on its way.`,
    forgotSentExpiry: (minutes: number) =>
      `The link can be used once, and stops working after ${minutes} minutes.`,
    forgotSentHint: 'Nothing arrived? Check your spam folder, then request another link.',
    forgotSendAgain: 'Use a different address',

    // --- Reset password ----------------------------------------------------
    resetTitle: 'Set a new password',
    resetDescription: 'Choose a new password for your account.',
    resetSubmit: 'Save new password',
    resetPending: 'Saving your new password…',
    resetLoading: 'Opening your reset link',
    resetDoneHeading: 'Password updated',
    resetDoneBody: 'Sign in with your new password to pick up where you left off.',
    /** TAR-35: a completed reset revokes every session the account had. */
    resetSessionsRevokedNotice:
      'For your security, this account has been signed out on every device — including any the person who requested this link was not using.',
    linkUnusableHeading: 'This reset link cannot be used',
    linkIncompleteBody:
      'The link is missing its token, which usually means it was truncated on the way to you. Open the most recent reset email again, or request a new link.',

    // --- Change password ---------------------------------------------------
    securityTitle: 'Security',
    securitySubtitle: 'Your password, and what happens to your other sessions when it changes.',
    securityLoading: 'Loading your security settings',
    changeHeading: 'Change password',
    changeDescription: 'You stay signed in here. Every other device is signed out.',
    signedInAs: 'Signed in as',
    changeSubmit: 'Change password',
    changePending: 'Changing your password…',
    changeSuccessToast: 'Password changed',
    changeDoneHeading: 'Password changed',
    /** TAR-35: a change revokes every session *except* the caller's own. */
    changeDoneBody:
      'You are still signed in on this device. Every other session for your account has been signed out and will need the new password.',
    changeAgain: 'Change it again',

    // --- Validation --------------------------------------------------------
    passwordRequiredError: 'Enter a password',
    currentPasswordRequiredError: 'Enter your current password',
    passwordTooShortError: (minLength: number) => `Use at least ${minLength} characters`,
    passwordTooLongError: (maxLength: number) => `Use at most ${maxLength} characters`,
    passwordMismatchError: 'The two passwords do not match',
  },

  /**
   * The supervisor's performance dashboard (TAR-30,
   * `docs/architecture/0010-reporting-dashboard-and-export.md`).
   *
   * Two things this copy has to carry, because the numbers are otherwise
   * ambiguous and end up in a client-facing report: **what each metric is
   * anchored on** (0010 decision 2 — "resolved this week" is over tickets
   * resolved this week, whenever they arrived), and **that the durations are
   * wall-clock** rather than business hours (0010 risk 2).
   */
  reports: {
    title: 'Performance',
    subtitle: 'Response and resolution times, ticket volume and per-agent workload.',

    filtersLabel: 'Report filters',

    // --- The range ----------------------------------------------------------
    /** Names `DateRangeField` for assistive technology; nothing shows it. */
    rangeHeading: 'Date range',
    presetLast7: 'Last 7 days',
    presetLast30: 'Last 30 days',
    presetLast90: 'Last 90 days',
    /** Said once, above the numbers, because every duration below inherits it. */
    rangeSummary: (from: string, to: string) => `${from} to ${to}, in your workspace’s time zone`,
    rangeOrderError: 'The start date must be on or before the end date',
    rangeTooLongError: (maxDays: number) => `Pick a range of ${String(maxDays)} days or fewer`,

    // --- Scope --------------------------------------------------------------
    scopeFilterLabel: 'Scope',
    scopeAll: 'All tickets',
    scopeAssigned: 'Assigned to me',
    /**
     * 0009 decision 6: without `report:read_all` the totals still cover
     * everything the caller can see, and the breakdown is narrowed to their own
     * row rather than the request being refused. Saying so is what stops an
     * agent reading a supervisor's shared link as a broken table.
     */
    scopeNarrowedNotice:
      'You are seeing your own and your teams’ tickets, and the breakdown shows your row only.',

    // --- The four metrics ---------------------------------------------------
    summaryHeading: 'Overview',
    summaryLoading: 'Loading dashboard metrics',
    volumeCreatedLabel: 'Tickets opened',
    volumeCreatedHint: 'Opened in this range, whatever happened to them since.',
    volumeResolvedLabel: 'Tickets resolved',
    volumeResolvedHint: 'Resolved in this range, whenever they were opened.',
    volumeClosedUnresolvedLabel: 'Closed unresolved',
    volumeClosedUnresolvedHint:
      'Closed in this range without ever being resolved — spam, wrong numbers, duplicates.',
    firstResponseLabel: 'First response time',
    /**
     * Says "median" in the hint rather than in the label: the headline figure is
     * the median on both duration cards, and a supervisor quoting a number from
     * this screen has to know which statistic they are quoting.
     */
    firstResponseHint:
      'Median, from the ticket opening to the first reply, for replies sent in this range.',
    resolutionLabel: 'Resolution time',
    resolutionHint:
      'Median, from the ticket opening to its resolution, for tickets resolved in this range.',
    /** Wall-clock, not business hours — 0009 risk 2, stated rather than assumed. */
    durationBasisNote: 'Durations are wall-clock, including nights and weekends.',

    statAverage: 'Average',
    statP90: '90th percentile',
    /**
     * How many tickets the median above was computed over, carried beside it as a
     * figure rather than as a sentence: a p90 over two tickets *is* one of those
     * two tickets, and a supervisor cannot tell that from the duration alone.
     */
    statSampleLabel: 'Tickets measured',
    /**
     * A duration is null exactly when nothing was measured, and the contract is
     * explicit that this is not zero: "no ticket was answered" and "every ticket
     * was answered instantly" are different facts.
     */
    noMeasurement: 'No data',
    /**
     * The same fact for the eye rather than for a screen reader. "No data"
     * repeated down two columns of a table reads as six problems where it is six
     * blanks; the words stay, visually hidden beside this (TAR-519).
     */
    noMeasurementMark: '—',
    /**
     * Names the info affordance beside a metric's label. It says what activating
     * it will do rather than repeating the metric's name, so a screen-reader user
     * moving through five tiles hears five distinct controls.
     */
    metricInfoLabel: (metric: string) => `${metric}: how it is measured`,

    // --- Per-agent breakdown ------------------------------------------------
    agentsHeading: 'By agent',
    agentsDescription:
      'Attributed to whoever answered and whoever resolved each ticket, not to whoever holds it now.',
    agentsLoading: 'Loading the per-agent breakdown',
    agentsEmptyHeading: 'Nobody has work in this range',
    agentsEmptyBody: 'Pick a wider range, or a scope that covers more of the workspace.',
    columnAgent: 'Agent',
    columnResolved: 'Resolved',
    columnFirstResponse: 'First response (median)',
    columnResolution: 'Resolution (median)',
    /**
     * The row for work whose responder or resolver was never recorded — a ticket
     * that predates the attribution columns, or a resolution with no actor. It is
     * rendered rather than hidden, so the table adds up to the totals above it.
     */
    /**
     * The sortable columns' controls. A header that sorts is a link, so the order
     * lands in the URL and a supervisor can send "sorted by slowest first" rather
     * than describe it — and the label says which way activating it will sort,
     * because `aria-sort` reports the current state and not the next one.
     */
    sortAscending: (column: string) => `Sort by ${column}, lowest first`,
    sortDescending: (column: string) => `Sort by ${column}, highest first`,
    unattributed: 'Not recorded',
    unattributedHint: 'Work whose agent was never recorded.',
    inactiveAgent: 'No longer active',
    /**
     * Said once, under the table, because the arithmetic is not the arithmetic a
     * reader expects: the overview's medians are computed over every ticket, and
     * a median column does not sum — averaging the rows above would give a
     * different, wrong number.
     */
    mediansDoNotSumNote:
      'The overview figures are computed over every ticket. Medians do not add up across rows.',

    // --- Daily volume -------------------------------------------------------
    seriesHeading: 'Daily volume',
    seriesDescription: 'Opened against resolved, one bar per day in your workspace’s time zone.',
    seriesLoading: 'Loading daily volume',
    seriesCreatedLegend: 'Opened',
    seriesResolvedLegend: 'Resolved',
    seriesDayLabel: (date: string, created: number, resolved: number) =>
      `${date}: ${String(created)} opened, ${String(resolved)} resolved`,
    seriesEmptyHeading: 'No tickets in this range',
    seriesEmptyBody: 'Nothing was opened or resolved between these dates.',
    /**
     * What the y-axis counts. Said once beside the gridlines rather than on every
     * tick, which would put "tickets" on the chart four times.
     */
    seriesValueAxisLabel: 'Tickets',
    /**
     * Read out when the chart takes focus, so a keyboard user is told the days
     * are reachable rather than discovering it. Visually hidden: a sighted user
     * has the columns in front of them.
     */
    seriesKeyboardHint: 'Use the left and right arrow keys to move between days.',
    /** The third figure the contract carries per day, shown on the day's readout. */
    seriesResponseLabel: 'First response (median)',
    seriesDayLabelWithResponse: (date: string, created: number, resolved: number, median: string) =>
      `${date}: ${String(created)} opened, ${String(resolved)} resolved, median first response ${median}`,

    // --- Taking the report away (TAR-431) -----------------------------------
    exportAction: 'Export CSV',
    /**
     * What a screen reader hears while the file is being prepared. The button's
     * default — the form layer's "Saving…" — would be wrong: nothing is written.
     */
    exportPending: 'Preparing your report',
    /**
     * The range is in the accessible name because the file is fixed by what is
     * on screen, and somebody arriving at the control by keyboard should not
     * have to hunt for which range they are about to download. It opens with the
     * visible label so speech input can still say "Export CSV" (WCAG 2.5.3).
     */
    exportAria: (from: string, to: string) => `Export CSV for ${from} to ${to}`,
    exportHint: 'The file covers exactly the range and scope shown on this page.',
    /** Specific, not "Done": it names the file that has just landed. */
    exportReady: (fileName: string) => `${fileName} downloaded`,
    exportFailed: 'We could not prepare that report. Try again in a moment.',
    exportForbidden: 'Your role cannot export this report. Ask a workspace admin if you need it.',
    /**
     * The console checks the range against the contract before sending it, so
     * reaching this means the API refused a range the screen thought was fine —
     * a shorter one is the thing the supervisor can actually do about it.
     */
    exportRangeRefused: 'That date range cannot be exported. Choose a shorter range and try again.',
  },

  form: {
    requiredFieldError: 'This field is required',
    invalidEmailError: 'Enter a valid email address',
    submitting: 'Saving…',
    genericSubmitError: 'We could not save that. Check the fields and try again.',
    /**
     * The key to the `*` every required `Field` renders (TAR-521). The marker
     * was on screen with nothing explaining it, which is SC 3.3.2 — a symbol
     * carrying an instruction has to be defined somewhere the reader can see.
     */
    requiredLegend: '* Required',
    /**
     * What a screen reader hears for one line of a live requirement checklist.
     * The tick and the muted dot are the sighted carriers; these are the other
     * half, so the state is never colour or shape alone.
     */
    requirementMet: 'Met',
    requirementUnmet: 'Not met',
  },

  mockNotice: {
    heading: 'Mock data',
    body: 'The console is reading fixtures. Point NEXT_PUBLIC_USE_MOCK_API at the real API once TAR-81 ships.',
  },
} as const;

export type Content = typeof content;
