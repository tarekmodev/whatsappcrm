import type {
  AgentAvailability,
  ConversationStatus,
  TenantRole,
  UserStatus,
} from '@whatsappcrm/contracts';

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
    assignedToTeam: (name: string) => `Team ${name}`,
    scopeNarrowedNotice:
      'Your role sees only the conversations assigned to you or your teams, so this list is narrowed.',
    lastActivity: 'Last activity',
    contact: 'Contact',
    status: 'Status',
    assignee: 'Assignee',
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
    requestNewLink: 'Request a new link',
    genericFailure: 'We could not complete that. Try again in a moment.',

    // --- Session ------------------------------------------------------------
    signOut: 'Sign out',

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
