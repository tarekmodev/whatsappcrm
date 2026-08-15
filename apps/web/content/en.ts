import type {
  AgentAvailability,
  ConversationStatus,
  FallbackAssignmentReason,
  MessageStatus,
  MessageType,
  OnboardingStepId,
  OnboardingStepStatus,
  SlaTargetKind,
  TenantRole,
  TicketPriority,
  TicketStatus,
  UserStatus,
  WhatsAppAccountStatus,
  WhatsAppBusinessVerificationStatus,
  WhatsAppQualityRating,
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
    menuHeading: 'Menu',
    collapseNav: 'Collapse navigation',
    expandNav: 'Expand navigation',
    inbox: 'Inbox',
    tickets: 'Tickets',
    reports: 'Reports',
    settings: 'Settings',
    people: 'People',
    assignment: 'Assignment',
    whatsapp: 'WhatsApp',
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
    placeholder: 'Search conversations',
    submit: 'Search',
    clear: 'Clear search',
    resultsFor: (term: string) => `Conversations matching “${term}”`,
    emptyHeading: 'Nothing matches that search',
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
    emptyHeading: 'No conversations here yet',
    emptyBody: 'Conversations assigned to you or your teams appear in this list.',
    emptyAllBody: 'Nothing in the workspace matches this filter.',
    unreadCount: (count: number) => `${count} unread`,
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
    botHandling: 'Bot is answering',

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
    /**
     * Said plainly rather than left as a missing button. Every role holds
     * `conversation:claim` since TAR-186, so this is now the rare case — a
     * principal whose role has had it taken away.
     */
    claimNotPermitted:
      'Anyone can read a conversation nobody has claimed. Your role cannot take one — ask a supervisor, and it will appear in your assigned list.',
    /**
     * Why the composer and the note box are shut on a thread in the shared pool
     * (TAR-186). The reason is the customer's, not the reader's role: two agents
     * looking at the same unclaimed thread would both reply, and claiming is
     * what makes one of them the one answering.
     */
    claimBeforeWriting:
      'Nobody is handling this conversation yet. Claim it to reply — that is what stops two of you answering the same customer.',

    // --- The two-pane layout ------------------------------------------------
    threadHeading: 'Conversation',
    backToList: 'Back to conversations',
    noThreadHeading: 'No conversation open',
    noThreadBody: 'Pick a conversation from the list to read it and reply.',
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
    ticketLinked: 'A ticket is open for this conversation.',
    ticketLinkedBody:
      'It was opened automatically when the customer wrote in, and everything said here is on it.',
    /**
     * The link the panel's original comment promised would land with
     * `GET /tickets/{id}`. Resolving the ticket empties this section rather than
     * leaving a link to work that is finished — `conversation.ticketId` names
     * the *active* ticket, so it goes null the moment one is resolved.
     */
    ticketOpen: 'Open the ticket',
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
     * Says what the order *is*, because it is not a control: the queue has one
     * order and no sort picker, so an agent who cannot see why a ticket is at
     * the top would otherwise have to guess.
     */
    queueOrderNotice: 'Urgent tickets come first, then the most recently opened.',
    emptyHeading: 'Nothing waiting',
    emptyBody: 'Tickets assigned to you or your teams appear here as customers write in.',
    emptyFilteredBody: 'Nothing matches this filter. Try a wider scope, status or priority.',
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

  thread: {
    messagesHeading: 'Messages',
    loading: 'Loading this conversation',
    emptyHeading: 'Nothing here yet',
    emptyBody: 'Messages in this conversation appear here as they arrive.',
    /** The thread opens on one page; older messages are a follow-up (TAR-20g). */
    olderMessagesNotice: (count: number) =>
      `Showing the most recent ${String(count)} messages in this conversation.`,
    inbound: 'From the customer',
    outbound: 'From your team',
    sentBy: (name: string) => `Sent by ${name}`,
    sentByAutomation: 'Sent automatically',
    /**
     * A person sent it and this page could not resolve which one. Distinct from
     * `sentByAutomation` on purpose: attributing a colleague's words to a bot is
     * a lie about the one thing this product is a record of.
     */
    sentByTeammate: 'Sent by a teammate',
    sentAt: 'Sent',
    failureReason: (reason: string) => `Not delivered: ${reason}`,
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
    windowOpenNotice: 'You can reply freely until then. After that, only an approved template.',
    windowClosedHeading: 'This conversation is outside the 24-hour window',
    windowClosedBody:
      'WhatsApp only accepts an approved template until the customer writes again. Send one below, and their reply reopens free messaging for another 24 hours.',
    /** The moment it happens, with the agent's draft still on screen. */
    windowJustClosedToast: 'The 24-hour window closed. Send an approved template instead.',

    // --- Free-form ----------------------------------------------------------
    replyLabel: 'Reply to the customer',
    replyPlaceholder: 'Write a reply…',
    replyHint: 'The customer receives this on WhatsApp.',
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
    /**
     * Said rather than left as a missing control. An agent without
     * `conversation:send` can read a thread and reply to nothing in it, and a
     * composer that simply was not there would read as a broken screen.
     */
    sendNotPermitted:
      'Your role can read this conversation but not reply to it. Ask a workspace admin.',

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
    filterRoleLabel: 'Filter by role',
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
    removeAgentTitle: 'Remove agent',
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
    flaggedFilteredEmptyBody: 'Other tickets may still be flagged — clear the filter to see them.',
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
    assignTicketSubmit: 'Assign ticket',
    assignTicketSuccess: (ticketLabel: string, agentName: string) =>
      `${ticketLabel} assigned to ${agentName}`,
    assignTicketNoAgentsError: 'Nobody in this workspace is active enough to take a ticket.',
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

    unconfiguredHeading: 'Self-service connection is not set up',
    unconfiguredBody:
      'This console has no Meta app configured for connecting WhatsApp yourself. Contact support and they can connect your WhatsApp Business Account for you.',

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

    // --- Session ------------------------------------------------------------
    signOut: 'Sign out',

    // --- Sign in -----------------------------------------------------------
    signInTitle: 'Sign in',
    signInDescription: 'Use the email address your workspace invited.',
    signInSubmit: 'Sign in',
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
   * `docs/architecture/0009-reporting-dashboard-and-export.md`).
   *
   * Two things this copy has to carry, because the numbers are otherwise
   * ambiguous and end up in a client-facing report: **what each metric is
   * anchored on** (0009 decision 2 — "resolved this week" is over tickets
   * resolved this week, whenever they arrived), and **that the durations are
   * wall-clock** rather than business hours (0009 risk 2).
   */
  reports: {
    title: 'Performance',
    subtitle: 'Response and resolution times, ticket volume and per-agent workload.',

    // --- The range ----------------------------------------------------------
    rangeHeading: 'Date range',
    rangeFromLabel: 'From',
    rangeToLabel: 'To',
    rangeApply: 'Apply range',
    rangePresetLabel: 'Quick ranges',
    presetLast7: 'Last 7 days',
    presetLast30: 'Last 30 days',
    presetLast90: 'Last 90 days',
    /** Said once, above the numbers, because every duration below inherits it. */
    rangeSummary: (from: string, to: string) => `${from} to ${to}, in your workspace’s time zone`,
    rangeOrderError: 'The start date must be on or before the end date',
    rangeTooLongError: (maxDays: number) => `Pick a range of ${String(maxDays)} days or fewer`,
    rangeInvalidError: 'Enter both dates as YYYY-MM-DD',

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
  },

  form: {
    requiredFieldError: 'This field is required',
    invalidEmailError: 'Enter a valid email address',
    submitting: 'Saving…',
    genericSubmitError: 'We could not save that. Check the fields and try again.',
  },

  mockNotice: {
    heading: 'Mock data',
    body: 'The console is reading fixtures. Point NEXT_PUBLIC_USE_MOCK_API at the real API once TAR-81 ships.',
  },
} as const;

export type Content = typeof content;
