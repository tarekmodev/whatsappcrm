import type {
  AgentAvailability,
  ConversationStatus,
  MessageStatus,
  MessageType,
  TenantRole,
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
    inbox: 'Inbox',
    settings: 'Settings',
    people: 'People',
    assignment: 'Assignment',
    whatsapp: 'WhatsApp',
    security: 'Security',
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
     * Said plainly rather than left as a missing button. ADR 0002 amendment 4
     * opens an unclaimed thread to every agent and rules that taking it still
     * needs `conversation:assign`, which an agent does not hold.
     */
    claimNotPermitted:
      'Anyone can read a conversation nobody has claimed. Taking one is a supervisor’s to do — ask, and it will appear in your assigned list.',

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
