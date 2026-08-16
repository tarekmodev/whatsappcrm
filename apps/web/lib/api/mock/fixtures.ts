import {
  ONBOARDING_STEP_IDS,
  type AssignmentRuleResponse,
  type ConversationResponse,
  type CustomFieldDefinition,
  type InternalNoteResponse,
  type MessageAttachment,
  type MessageResponse,
  type MessageTemplateResponse,
  type OnboardingStep,
  type SlaAlertResponse,
  type Tag,
  type TeamResponse,
  type TenantLifecycleResponse,
  type TenantResponse,
  type TenantRole,
  type TicketEvent,
  type TicketResponse,
  type TicketRouting,
  type TicketSla,
  type UserResponse,
  type WorkflowResponse,
  type WorkflowRunResponse,
} from '@whatsappcrm/contracts';
import { MOCK_AUDIO_URL, MOCK_DOCUMENT_URL, MOCK_IMAGE_URL } from '@/lib/api/mock/media-fixtures';

/**
 * Fixture data for the mock transport (TAR-82 builds ahead of TAR-81's
 * endpoints). Two tenants are seeded deliberately: the second one exists purely
 * so tenant scoping is something the mock can be *tested* against rather than
 * assumed.
 *
 * Every id and timestamp is a literal. Generating them would make server and
 * client render different markup and break hydration, and would make the tests
 * time-dependent.
 */

export const MOCK_TENANT_ID = '0192f000-0000-7000-8000-00000000a001';
export const OTHER_TENANT_ID = '0192f000-0000-7000-8000-00000000b001';

/** The signed-in principal in stub mode, one per role, all in `MOCK_TENANT_ID`. */
export const MOCK_STUB_USER_IDS: Record<TenantRole, string> = {
  agent: '0192f001-0000-7000-8000-000000000101',
  supervisor: '0192f001-0000-7000-8000-000000000102',
  admin: '0192f001-0000-7000-8000-000000000103',
};

const TEAM_IDS = {
  billing: '0192f002-0000-7000-8000-000000000201',
  onboarding: '0192f002-0000-7000-8000-000000000202',
  otherTenant: '0192f002-0000-7000-8000-000000000299',
} as const;

const USER_IDS = {
  amina: MOCK_STUB_USER_IDS.agent,
  priya: MOCK_STUB_USER_IDS.supervisor,
  omar: MOCK_STUB_USER_IDS.admin,
  liang: '0192f001-0000-7000-8000-000000000104',
  noor: '0192f001-0000-7000-8000-000000000105',
  otherTenant: '0192f001-0000-7000-8000-000000000199',
} as const;

const CONTACT_IDS = {
  fatima: '0192f003-0000-7000-8000-000000000301',
  jonas: '0192f003-0000-7000-8000-000000000302',
  mei: '0192f003-0000-7000-8000-000000000303',
  /**
   * Three contacts with no conversation of their own, carried by the deferred
   * tickets below.
   *
   * They exist because `tickets_one_active_per_contact` is a real partial unique
   * index: Fatima, Jonas and Mei each already hold one *active* ticket, so hanging
   * a second one off them would make this fixture set something the database
   * would refuse to hold — and a mock that cannot exist is worse than no mock.
   */
  sofia: '0192f003-0000-7000-8000-000000000304',
  karim: '0192f003-0000-7000-8000-000000000305',
  yuki: '0192f003-0000-7000-8000-000000000306',
  otherTenant: '0192f003-0000-7000-8000-000000000399',
} as const;

const CONVERSATION_IDS = {
  assignedToAmina: '0192f004-0000-7000-8000-000000000401',
  billingTeam: '0192f004-0000-7000-8000-000000000402',
  assignedToLiang: '0192f004-0000-7000-8000-000000000403',
  unassigned: '0192f004-0000-7000-8000-000000000404',
  otherTenant: '0192f004-0000-7000-8000-000000000499',
} as const;

const TICKET_IDS = {
  /** Fatima's live issue: the urgent one, so the queue's sort is visible. */
  fatimaUrgent: '0192f00a-0000-7000-8000-000000000a01',
  /** Waiting on Jonas, routed to Billing and held by nobody in particular. */
  jonasPending: '0192f00a-0000-7000-8000-000000000a02',
  /** Nobody's: what `scope=unassigned` is for, and only a supervisor sees it. */
  meiUnassigned: '0192f00a-0000-7000-8000-000000000a03',
  /** Terminal, so it is absent from the active queue rather than merely marked. */
  fatimaResolved: '0192f00a-0000-7000-8000-000000000a04',
  /** Closed without a resolution: `closedAt` set, `resolvedAt` deliberately null. */
  meiClosed: '0192f00a-0000-7000-8000-000000000a05',
  /**
   * Resolved in July and closed days later, by an agent on the other team.
   *
   * It exists for the dashboard (TAR-30): a single resolved ticket gives a
   * median that is also the mean and the p90, so nothing about how the durations
   * are computed would be visible, and one agent's row would be the whole table.
   * It is `closed` rather than `resolved` on purpose — volume is anchored on
   * `resolvedAt`, not on status (ADR 0009 decision 2), so this ticket counts as
   * resolved work while being absent from every queue.
   */
  jonasResolvedThenClosed: '0192f00a-0000-7000-8000-000000000a09',
  // The supervisor's deferred queue (TAR-23): one per reason in ADR 0008's
  // vocabulary, because a set holding only `all_at_capacity` would leave two
  // thirds of the copy that tells a supervisor *who* must act unreachable.
  /** Routed to Billing by rule, and then nobody in Billing had room. */
  deferredAtCapacity: '0192f00a-0000-7000-8000-000000000a06',
  /** Onboarding exists and is asleep: a staffing gap, not a configuration one. */
  deferredNoneAvailable: '0192f00a-0000-7000-8000-000000000a07',
  /** Nobody could ever have taken it — the reason that never resolves itself. */
  deferredNoCandidatePool: '0192f00a-0000-7000-8000-000000000a08',
  otherTenant: '0192f00a-0000-7000-8000-000000000a99',
  /**
   * A *deferred* ticket in the other tenant. The `otherTenant` ticket above is
   * `open`, so it falls out of `?routingState=deferred` on its own and cannot
   * prove the flagged query is tenant-scoped. This one can.
   */
  otherTenantDeferred: '0192f00a-0000-7000-8000-000000000a98',
} as const;

/**
 * Each entity type owns a `0192fNNN` prefix, so an id read out of a log or a
 * failing assertion says which fixture it came from. Templates hold `…009` and
 * tickets `…00a`, so routing's three start at `…00b`.
 */
const TAG_IDS = {
  vip: '0192f00b-0000-7000-8000-000000000b01',
  refundRequested: '0192f00b-0000-7000-8000-000000000b02',
  /** TAR-27's own worked example: "escalate it and tag it `escalated`". */
  escalated: '0192f00b-0000-7000-8000-000000000b03',
  otherTenant: '0192f00b-0000-7000-8000-000000000b99',
} as const;

const CUSTOM_FIELD_IDS = {
  planTier: '0192f00c-0000-7000-8000-000000000c01',
  accountManager: '0192f00c-0000-7000-8000-000000000c02',
  otherTenant: '0192f00c-0000-7000-8000-000000000c99',
} as const;

const ASSIGNMENT_RULE_IDS = {
  billingKeywords: '0192f00d-0000-7000-8000-000000000d01',
  outOfHours: '0192f00d-0000-7000-8000-000000000d02',
  vipContacts: '0192f00d-0000-7000-8000-000000000d03',
  /** Deactivated by the removal of its target user, so it has no target left. */
  orphaned: '0192f00d-0000-7000-8000-000000000d04',
  otherTenant: '0192f00d-0000-7000-8000-000000000d99',
} as const;

const TENANT_DOMAIN_IDS = {
  northwindPlatform: '0192f00e-0000-7000-8000-000000000e01',
  southwindPlatform: '0192f00e-0000-7000-8000-000000000e99',
} as const;

/**
 * A trial that is still running, so the plan panel renders its countdown rather
 * than the expired state. A literal like every other timestamp here — a
 * generated one would make server and client render different markup — which
 * means it eventually falls into the past. When it does, mock mode shows the
 * trial as ended; that is a fixture aging out, not the countdown breaking.
 */
const TRIAL_ENDS_AT = '2026-08-29T09:00:00.000Z';

const WHATSAPP_ACCOUNT_ID = '0192f005-0000-7000-8000-000000000501';
const WHATSAPP_BUSINESS_ACCOUNT_ID = '0192f005-0000-7000-8000-000000000502';

/**
 * A window that stays open, so the composer's free-form half is reachable.
 *
 * Every other timestamp in this file is a literal moment in the fixtures' own
 * story, and stays one. This one cannot be, and no value is right: the service
 * window is *relative to now* by definition, so a literal is either near enough
 * to expire — leaving mock mode able to render only the outside-the-window
 * state — or far enough not to, which is this. It has to stay a literal, because
 * a generated timestamp would make server and client render different markup.
 *
 * ⚠️ The consequence is visible and is **not a bug in the countdown**: the
 * composer's banner reads "Free replies close in 26,440 days" in mock mode. A
 * real window is under 24 hours and reads in hours or minutes.
 */
const OPEN_SERVICE_WINDOW = '2099-01-01T00:00:00.000Z';

/**
 * When the seeded checklists were last touched. A literal, like every other
 * timestamp here: `Date.now()` would make server and client render different
 * markup and break hydration.
 */
const MOCK_ONBOARDING_UPDATED_AT = '2026-08-10T12:00:00.000Z';

/** A record is only ever read through a handler that filters on this field. */
export interface TenantScoped {
  readonly tenantId: string;
}

export type MockUser = UserResponse & TenantScoped;
export type MockTeam = TeamResponse & TenantScoped;
export type MockTag = Tag & TenantScoped;
export type MockCustomFieldDefinition = CustomFieldDefinition & TenantScoped;
export type MockAssignmentRule = AssignmentRuleResponse & TenantScoped;
export type MockConversation = ConversationResponse & TenantScoped;
export type MockMessage = MessageResponse & TenantScoped;
export type MockInternalNote = InternalNoteResponse & TenantScoped;
/**
 * `TicketResponse` names no responder or resolver — ADR 0009 decision 4 records
 * both as columns on `tickets`, and neither is published: the dashboard groups by
 * them, and no client has any use for them on a ticket. The fixture keeps them
 * for the reason `MockSlaAlert` keeps its recipient — a transport that could not
 * tell whose work a resolution was could not exercise the per-agent breakdown at
 * all — and `toTicketResponse` strips them on the way out.
 *
 * `null` is "not recorded", which the report renders as its unattributed row
 * rather than redistributing.
 */
export type MockTicket = TicketResponse &
  TenantScoped & {
    readonly firstResponseUserId: string | null;
    readonly resolvedByUserId: string | null;
  };

/**
 * `SlaAlertResponse` names no recipient — the API narrows to the caller, so the
 * column never crosses the wire. The fixture keeps it, because a transport that
 * could not tell one supervisor's alerts from another's could not exercise the
 * narrowing this feature's role-scoping rests on.
 */
export type MockSlaAlert = SlaAlertResponse & TenantScoped & { readonly recipientUserId: string };

export type MockTicketEvent = TicketEvent & TenantScoped;

/**
 * One tenant's onboarding checklist. Keyed by tenant in the store rather than by
 * an id of its own: a tenant has exactly one, and giving it a surrogate id would
 * invite a handler to look it up by something other than the caller's tenant.
 */
export type MockOnboardingChecklist = TenantScoped & {
  steps: OnboardingStep[];
  completedAt: string | null;
  updatedAt: string;
};

/**
 * Both tenants start with everything pending — a brand-new workspace, which is
 * the state this checklist exists for.
 *
 * `connect_whatsapp` and `invite_agents` are flipped to `completed` by the
 * handlers that do the real thing (connecting a WABA, sending an invitation), not
 * by a client PATCH: completion is server-derived, per `contracts/onboarding.ts`.
 * `set_branding` therefore stays pending until TAR-29 ships a branding write —
 * which is exactly the case the skip path exists for, and worth being able to
 * walk.
 */
export const MOCK_ONBOARDING_CHECKLISTS: readonly MockOnboardingChecklist[] = [
  MOCK_TENANT_ID,
  OTHER_TENANT_ID,
].map((tenantId) => ({
  tenantId,
  steps: ONBOARDING_STEP_IDS.map((id) => ({
    id,
    status: 'pending' as const,
    completedAt: null,
    skippedAt: null,
  })),
  completedAt: null,
  updatedAt: MOCK_ONBOARDING_UPDATED_AT,
}));

function contact(id: string, displayName: string, phone: string): ConversationResponse['contact'] {
  return {
    id,
    phone,
    waProfileName: displayName,
    displayName,
    email: null,
    tags: [],
    customFields: {},
    lastContactedAt: '2026-08-09T09:15:00.000Z',
    optedOutAt: null,
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-08-09T09:15:00.000Z',
  };
}

/**
 * The lifecycle half of a tenant: `GET /v1/tenant/lifecycle` minus `usage`,
 * which is counted live from the users and conversations in this same store
 * rather than stored, so the seat meter moves when a reviewer sends an invite.
 */
export type MockTenantLifecycle = Omit<TenantLifecycleResponse, 'usage'> & TenantScoped;

export const MOCK_TENANTS: readonly TenantResponse[] = [
  {
    id: MOCK_TENANT_ID,
    name: 'Northwind Traders',
    slug: 'northwind',
    status: 'trialing',
    branding: {
      logoUrl: null,
      faviconUrl: null,
      primaryColor: '#16a34a',
      accentColor: '#15803d',
      productName: 'Northwind Support',
      supportEmail: 'support@northwind.example',
    },
    domains: [
      {
        id: TENANT_DOMAIN_IDS.northwindPlatform,
        hostname: 'northwind.app.example.com',
        kind: 'platform_subdomain',
        verifiedAt: '2026-07-01T09:00:00.000Z',
        isPrimary: true,
      },
    ],
    trialEndsAt: TRIAL_ENDS_AT,
    createdAt: '2026-07-01T09:00:00.000Z',
  },
  {
    // Present only so tenant scoping can be asserted, never rendered.
    id: OTHER_TENANT_ID,
    name: 'Southwind Ltd',
    slug: 'southwind',
    status: 'active',
    branding: {
      logoUrl: null,
      faviconUrl: null,
      primaryColor: '#2563eb',
      accentColor: '#1d4ed8',
      productName: 'Southwind Helpdesk',
      supportEmail: null,
    },
    domains: [
      {
        id: TENANT_DOMAIN_IDS.southwindPlatform,
        hostname: 'southwind.app.example.com',
        kind: 'platform_subdomain',
        verifiedAt: '2026-06-01T09:00:00.000Z',
        isPrimary: true,
      },
    ],
    trialEndsAt: null,
    createdAt: '2026-06-01T09:00:00.000Z',
  },
];

/**
 * ADR 0009 seeds the `trial` plan at **three** seats, and this fixture says
 * five. The deviation is deliberate and is the honest one: three is what a
 * *fresh* signup gets, while Northwind already has four active agents and an
 * outstanding invitation, so a three-seat cap here would render "5 of 3" — a
 * state write-time enforcement makes unreachable, and therefore a state the
 * console should never be designed against.
 *
 * Five puts the fixture exactly *at* its cap, which is the state worth having
 * on screen by default: it is the one the meter warns about and the one that
 * explains why the next invitation is refused.
 */
export const MOCK_TENANT_LIFECYCLES: readonly MockTenantLifecycle[] = [
  {
    tenantId: MOCK_TENANT_ID,
    status: 'trialing',
    trialEndsAt: TRIAL_ENDS_AT,
    gracePeriodEndsAt: null,
    purgeAt: null,
    plan: {
      key: 'trial',
      name: 'Trial',
      entitlements: {
        features: ['assignment_rules', 'sla_policies'],
        limits: {
          seats: 5,
          conversationsPerPeriod: 1000,
          whatsappNumbers: 1,
          teams: 2,
          knowledgeDocuments: 10,
        },
      },
    },
  },
  {
    tenantId: OTHER_TENANT_ID,
    status: 'active',
    trialEndsAt: null,
    gracePeriodEndsAt: null,
    purgeAt: null,
    plan: {
      key: 'trial',
      name: 'Trial',
      entitlements: {
        features: [],
        limits: {
          seats: 3,
          conversationsPerPeriod: 1000,
          whatsappNumbers: 1,
          teams: 2,
          knowledgeDocuments: 10,
        },
      },
    },
  },
];

export const MOCK_USERS: readonly MockUser[] = [
  {
    tenantId: MOCK_TENANT_ID,
    id: USER_IDS.amina,
    email: 'amina@northwind.example',
    displayName: 'Amina Haddad',
    avatarUrl: null,
    role: 'agent',
    status: 'active',
    availability: 'available',
    teamIds: [TEAM_IDS.billing],
    occupiesSeat: true,
    lastSeenAt: '2026-08-10T08:40:00.000Z',
    // The mock transport does not model lockout yet: TAR-59 adds the enforcement
    // that moves this off `null`, and TAR-35 the admin view that reads it. Until
    // then every fixture reports "you are not allowed to know", which is a valid
    // `UserResponse` and keeps the console from rendering invented lockout state.
    security: null,
    createdAt: '2026-07-02T10:00:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: USER_IDS.priya,
    email: 'priya@northwind.example',
    displayName: 'Priya Raman',
    avatarUrl: null,
    role: 'supervisor',
    status: 'active',
    availability: 'available',
    teamIds: [TEAM_IDS.billing, TEAM_IDS.onboarding],
    occupiesSeat: true,
    lastSeenAt: '2026-08-10T08:55:00.000Z',
    security: null,
    createdAt: '2026-07-02T10:05:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: USER_IDS.omar,
    email: 'omar@northwind.example',
    displayName: 'Omar Farouk',
    avatarUrl: null,
    role: 'admin',
    status: 'active',
    availability: 'away',
    teamIds: [],
    occupiesSeat: true,
    lastSeenAt: '2026-08-10T07:10:00.000Z',
    security: null,
    createdAt: '2026-07-01T09:00:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: USER_IDS.liang,
    email: 'liang@northwind.example',
    displayName: 'Liang Wei',
    avatarUrl: null,
    role: 'agent',
    status: 'active',
    availability: 'offline',
    teamIds: [TEAM_IDS.onboarding],
    occupiesSeat: true,
    lastSeenAt: '2026-08-08T16:20:00.000Z',
    security: null,
    createdAt: '2026-07-05T11:30:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: USER_IDS.noor,
    email: 'noor@northwind.example',
    displayName: 'Noor Sayed',
    avatarUrl: null,
    role: 'agent',
    status: 'invited',
    availability: 'offline',
    teamIds: [],
    occupiesSeat: false,
    lastSeenAt: null,
    security: null,
    createdAt: '2026-08-09T13:00:00.000Z',
  },
  {
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: USER_IDS.otherTenant,
    email: 'rival@southwind.example',
    displayName: 'Rival Tenant Admin',
    avatarUrl: null,
    role: 'admin',
    status: 'active',
    availability: 'available',
    teamIds: [TEAM_IDS.otherTenant],
    occupiesSeat: true,
    lastSeenAt: '2026-08-10T08:00:00.000Z',
    security: null,
    createdAt: '2026-06-01T09:00:00.000Z',
  },
];

export const MOCK_TEAMS: readonly MockTeam[] = [
  {
    tenantId: MOCK_TENANT_ID,
    id: TEAM_IDS.billing,
    name: 'Billing',
    description: 'Payment, invoice and refund questions.',
    memberUserIds: [USER_IDS.amina, USER_IDS.priya],
    createdAt: '2026-07-02T10:10:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: TEAM_IDS.onboarding,
    name: 'Onboarding',
    description: 'New customer setup and activation.',
    memberUserIds: [USER_IDS.priya, USER_IDS.liang],
    createdAt: '2026-07-06T09:00:00.000Z',
  },
  {
    tenantId: OTHER_TENANT_ID,
    id: TEAM_IDS.otherTenant,
    name: 'Rival Tenant Team',
    description: null,
    memberUserIds: [USER_IDS.otherTenant],
    createdAt: '2026-06-01T09:10:00.000Z',
  },
];

export const MOCK_CONVERSATIONS: readonly MockConversation[] = [
  {
    tenantId: MOCK_TENANT_ID,
    id: CONVERSATION_IDS.assignedToAmina,
    contact: contact(CONTACT_IDS.fatima, 'Fatima Al-Zahra', '+966501234567'),
    whatsappAccountId: WHATSAPP_ACCOUNT_ID,
    status: 'open',
    assignedUserId: USER_IDS.amina,
    assignedTeamId: TEAM_IDS.billing,
    // The contact's *active* ticket. It goes null the moment that ticket is
    // resolved, which is what empties the inbox context panel's ticket section.
    ticketId: TICKET_IDS.fatimaUrgent,
    unreadCount: 2,
    // The one open window in the set; every other thread here is outside it, so
    // both halves of the composer can be walked without editing a fixture.
    serviceWindowExpiresAt: OPEN_SERVICE_WINDOW,
    botHandling: false,
    lastMessagePreview: 'Could you resend the July invoice?',
    lastMessageAt: '2026-08-10T08:45:00.000Z',
    createdAt: '2026-08-09T14:00:00.000Z',
    updatedAt: '2026-08-10T08:45:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: CONVERSATION_IDS.billingTeam,
    contact: contact(CONTACT_IDS.jonas, 'Jonas Berg', '+4640123456'),
    whatsappAccountId: WHATSAPP_ACCOUNT_ID,
    status: 'pending',
    assignedUserId: null,
    assignedTeamId: TEAM_IDS.billing,
    ticketId: TICKET_IDS.jonasPending,
    unreadCount: 0,
    serviceWindowExpiresAt: '2026-08-11T06:30:00.000Z',
    botHandling: false,
    lastMessagePreview: 'Thanks, I will check with accounting.',
    lastMessageAt: '2026-08-10T06:30:00.000Z',
    createdAt: '2026-08-08T11:00:00.000Z',
    updatedAt: '2026-08-10T06:30:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: CONVERSATION_IDS.assignedToLiang,
    contact: contact(CONTACT_IDS.mei, 'Mei Tanaka', '+81312345678'),
    whatsappAccountId: WHATSAPP_ACCOUNT_ID,
    status: 'open',
    assignedUserId: USER_IDS.liang,
    assignedTeamId: TEAM_IDS.onboarding,
    ticketId: TICKET_IDS.meiUnassigned,
    unreadCount: 5,
    serviceWindowExpiresAt: null,
    botHandling: false,
    lastMessagePreview: 'The activation link has expired again.',
    lastMessageAt: '2026-08-09T22:10:00.000Z',
    createdAt: '2026-08-07T09:00:00.000Z',
    updatedAt: '2026-08-09T22:10:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: CONVERSATION_IDS.unassigned,
    contact: contact(CONTACT_IDS.fatima, 'Fatima Al-Zahra', '+966501234567'),
    whatsappAccountId: WHATSAPP_ACCOUNT_ID,
    status: 'open',
    assignedUserId: null,
    assignedTeamId: null,
    ticketId: null,
    unreadCount: 1,
    serviceWindowExpiresAt: '2026-08-11T10:00:00.000Z',
    botHandling: true,
    lastMessagePreview: 'Hello, is anyone there?',
    lastMessageAt: '2026-08-10T09:05:00.000Z',
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:05:00.000Z',
  },
  {
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: CONVERSATION_IDS.otherTenant,
    contact: contact(CONTACT_IDS.otherTenant, 'Rival Tenant Contact', '+12025550199'),
    whatsappAccountId: WHATSAPP_ACCOUNT_ID,
    status: 'open',
    assignedUserId: USER_IDS.otherTenant,
    assignedTeamId: TEAM_IDS.otherTenant,
    ticketId: null,
    unreadCount: 9,
    serviceWindowExpiresAt: null,
    botHandling: false,
    lastMessagePreview: 'This must never appear in another tenant’s console.',
    lastMessageAt: '2026-08-10T08:00:00.000Z',
    createdAt: '2026-06-02T09:00:00.000Z',
    updatedAt: '2026-08-10T08:00:00.000Z',
  },
];

// --- The thread ------------------------------------------------------------
//
// Deliberately covers every branch the thread view has: text and the four media
// kinds, in both directions, plus the two states an inbound attachment can be in
// before it is `stored` — `pending`, because the download runs off the ingest
// path, and `failed`, because Meta's handle expires. A fixture set that only
// held happy-path text would leave four renderers unreviewable.

const MESSAGE_IDS = {
  aminaInboundText: '0192f006-0000-7000-8000-000000000601',
  aminaInboundImage: '0192f006-0000-7000-8000-000000000602',
  aminaOutboundText: '0192f006-0000-7000-8000-000000000603',
  aminaOutboundDocument: '0192f006-0000-7000-8000-000000000604',
  aminaInboundAudio: '0192f006-0000-7000-8000-000000000605',
  aminaInboundPendingImage: '0192f006-0000-7000-8000-000000000606',
  aminaFailedDocument: '0192f006-0000-7000-8000-000000000607',
  aminaOutboundFailed: '0192f006-0000-7000-8000-000000000608',
  aminaInboundLocation: '0192f006-0000-7000-8000-000000000609',
  billingTeamInbound: '0192f006-0000-7000-8000-000000000611',
  liangInbound: '0192f006-0000-7000-8000-000000000612',
  unassignedInbound: '0192f006-0000-7000-8000-000000000613',
  otherTenant: '0192f006-0000-7000-8000-000000000699',
} as const;

const ATTACHMENT_IDS = {
  invoicePhoto: '0192f007-0000-7000-8000-000000000701',
  statementPdf: '0192f007-0000-7000-8000-000000000702',
  voiceNote: '0192f007-0000-7000-8000-000000000703',
  pendingPhoto: '0192f007-0000-7000-8000-000000000704',
  failedDocument: '0192f007-0000-7000-8000-000000000705',
} as const;

const NOTE_IDS = {
  priyaOnAmina: '0192f008-0000-7000-8000-000000000801',
  aminaOnAmina: '0192f008-0000-7000-8000-000000000802',
} as const;

function attachment(
  overrides: Partial<MessageAttachment> & Pick<MessageAttachment, 'id' | 'kind' | 'mimeType'>,
): MessageAttachment {
  return {
    providerMediaId: null,
    url: null,
    downloadState: 'stored',
    fileName: null,
    sizeBytes: null,
    ...overrides,
  };
}

function message(
  overrides: Partial<MockMessage> &
    Pick<MockMessage, 'id' | 'conversationId' | 'direction' | 'type' | 'sentAt'>,
): MockMessage {
  return {
    tenantId: MOCK_TENANT_ID,
    status: overrides.direction === 'inbound' ? 'delivered' : 'read',
    body: null,
    attachments: [],
    sentByUserId: null,
    sentByAutomation: false,
    providerMessageId: null,
    failureReason: null,
    createdAt: overrides.sentAt,
    ...overrides,
  };
}

export const MOCK_MESSAGES: readonly MockMessage[] = [
  message({
    id: MESSAGE_IDS.aminaInboundText,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    direction: 'inbound',
    type: 'text',
    body: 'Hello — I still have not received the July invoice.',
    sentAt: '2026-08-10T08:05:00.000Z',
  }),
  message({
    id: MESSAGE_IDS.aminaInboundImage,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    direction: 'inbound',
    type: 'image',
    body: 'This is the confirmation screen I get.',
    attachments: [
      attachment({
        id: ATTACHMENT_IDS.invoicePhoto,
        kind: 'image',
        mimeType: 'image/png',
        url: MOCK_IMAGE_URL,
        sizeBytes: 184_320,
      }),
    ],
    sentAt: '2026-08-10T08:07:00.000Z',
  }),
  message({
    id: MESSAGE_IDS.aminaOutboundText,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    direction: 'outbound',
    type: 'text',
    body: 'Thanks — I can see it. Sending the invoice across now.',
    sentByUserId: USER_IDS.amina,
    sentAt: '2026-08-10T08:20:00.000Z',
  }),
  message({
    id: MESSAGE_IDS.aminaOutboundDocument,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    direction: 'outbound',
    type: 'document',
    status: 'delivered',
    body: 'July statement, attached.',
    sentByUserId: USER_IDS.amina,
    attachments: [
      attachment({
        id: ATTACHMENT_IDS.statementPdf,
        kind: 'document',
        mimeType: 'application/pdf',
        url: MOCK_DOCUMENT_URL,
        fileName: 'northwind-july-statement.pdf',
        sizeBytes: 248_000,
      }),
    ],
    sentAt: '2026-08-10T08:22:00.000Z',
  }),
  message({
    id: MESSAGE_IDS.aminaInboundAudio,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    direction: 'inbound',
    type: 'audio',
    attachments: [
      attachment({
        id: ATTACHMENT_IDS.voiceNote,
        kind: 'audio',
        mimeType: 'audio/ogg',
        url: MOCK_AUDIO_URL,
        sizeBytes: 41_216,
      }),
    ],
    sentAt: '2026-08-10T08:30:00.000Z',
  }),
  message({
    id: MESSAGE_IDS.aminaInboundPendingImage,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    direction: 'inbound',
    type: 'image',
    // The message exists and its picture does not: the download runs off the
    // ingest path, so this interval is real rather than hypothetical.
    attachments: [
      attachment({
        id: ATTACHMENT_IDS.pendingPhoto,
        kind: 'image',
        mimeType: 'image/jpeg',
        downloadState: 'pending',
        providerMediaId: '1234567890',
      }),
    ],
    sentAt: '2026-08-10T08:35:00.000Z',
  }),
  message({
    id: MESSAGE_IDS.aminaFailedDocument,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    direction: 'inbound',
    type: 'document',
    body: 'And here is the receipt.',
    attachments: [
      attachment({
        id: ATTACHMENT_IDS.failedDocument,
        kind: 'document',
        mimeType: 'application/pdf',
        downloadState: 'failed',
        fileName: 'receipt.pdf',
      }),
    ],
    sentAt: '2026-08-10T08:36:00.000Z',
  }),
  message({
    id: MESSAGE_IDS.aminaOutboundFailed,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    direction: 'outbound',
    type: 'text',
    status: 'failed',
    body: 'Could you confirm the billing address?',
    sentByUserId: USER_IDS.amina,
    failureReason: '131047 — re-engagement message outside the 24-hour window',
    sentAt: '2026-08-10T08:40:00.000Z',
  }),
  message({
    id: MESSAGE_IDS.aminaInboundLocation,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    direction: 'inbound',
    // Nothing renders a map; the thread labels it rather than leaving a gap.
    type: 'location',
    sentAt: '2026-08-10T08:45:00.000Z',
  }),
  message({
    id: MESSAGE_IDS.billingTeamInbound,
    conversationId: CONVERSATION_IDS.billingTeam,
    direction: 'inbound',
    type: 'text',
    body: 'Thanks, I will check with accounting.',
    sentAt: '2026-08-10T06:30:00.000Z',
  }),
  message({
    id: MESSAGE_IDS.liangInbound,
    conversationId: CONVERSATION_IDS.assignedToLiang,
    direction: 'inbound',
    type: 'text',
    body: 'The activation link has expired again.',
    sentAt: '2026-08-09T22:10:00.000Z',
  }),
  message({
    id: MESSAGE_IDS.unassignedInbound,
    conversationId: CONVERSATION_IDS.unassigned,
    direction: 'inbound',
    type: 'text',
    body: 'Hello, is anyone there?',
    sentAt: '2026-08-10T09:05:00.000Z',
  }),
  message({
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: MESSAGE_IDS.otherTenant,
    conversationId: CONVERSATION_IDS.otherTenant,
    direction: 'inbound',
    type: 'text',
    body: 'This must never appear in another tenant’s console.',
    sentAt: '2026-08-10T08:00:00.000Z',
  }),
];

export const MOCK_INTERNAL_NOTES: readonly MockInternalNote[] = [
  {
    tenantId: MOCK_TENANT_ID,
    id: NOTE_IDS.aminaOnAmina,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    authorUserId: USER_IDS.amina,
    body: 'Statement resent. Waiting on the billing address before I close this.',
    mentionedUserIds: [],
    createdAt: '2026-08-10T08:25:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: NOTE_IDS.priyaOnAmina,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    authorUserId: USER_IDS.priya,
    body: 'Refund was already approved on the account — no need to escalate.',
    mentionedUserIds: [USER_IDS.amina],
    createdAt: '2026-08-10T08:50:00.000Z',
  },
];

// --- Templates (TAR-20a) ---------------------------------------------------
//
// One per shape the composer has to fill: no header, a `text` header with its
// own placeholder, and a media header. A set that was all plain-body templates
// would leave the header fields — the part 0002 amendment 1 exists for —
// unreachable in mock mode.

const TEMPLATE_IDS = {
  orderUpdate: '0192f009-0000-7000-8000-000000000901',
  appointmentReminder: '0192f009-0000-7000-8000-000000000902',
  invoiceReady: '0192f009-0000-7000-8000-000000000903',
  otherTenant: '0192f009-0000-7000-8000-000000000999',
} as const;

export type MockMessageTemplate = MessageTemplateResponse & TenantScoped;

function template(
  overrides: Partial<MockMessageTemplate> & Pick<MockMessageTemplate, 'id' | 'name' | 'bodyText'>,
): MockMessageTemplate {
  return {
    tenantId: MOCK_TENANT_ID,
    whatsappBusinessAccountId: WHATSAPP_BUSINESS_ACCOUNT_ID,
    language: 'en_US',
    category: 'UTILITY',
    // The endpoint returns approved templates only; there is no other value a
    // fixture reachable through it may hold.
    status: 'approved',
    components: null,
    parameterCount: 0,
    headerFormat: null,
    headerParameterCount: 0,
    // Always false on this endpoint: templates whose buttons take a parameter
    // are excluded from it entirely.
    requiresButtonParameters: false,
    providerTemplateId: null,
    createdAt: '2026-07-10T09:00:00.000Z',
    updatedAt: '2026-07-10T09:00:00.000Z',
    ...overrides,
  };
}

export const MOCK_MESSAGE_TEMPLATES: readonly MockMessageTemplate[] = [
  template({
    id: TEMPLATE_IDS.appointmentReminder,
    name: 'appointment_reminder',
    bodyText: 'Hello {{1}}, this is a reminder of your appointment on {{2}}.',
    parameterCount: 2,
  }),
  template({
    id: TEMPLATE_IDS.invoiceReady,
    name: 'invoice_ready',
    bodyText: 'Your invoice {{1}} is ready.',
    parameterCount: 1,
    // A media header: nothing may be sent for this one without an upload.
    headerFormat: 'document',
  }),
  template({
    id: TEMPLATE_IDS.orderUpdate,
    name: 'order_update',
    bodyText: 'Hi {{1}} — order {{2}} is now {{3}}.',
    parameterCount: 3,
    // A `text` header with a placeholder of its own, counted separately.
    headerFormat: 'text',
    headerParameterCount: 1,
  }),
  template({
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: TEMPLATE_IDS.otherTenant,
    name: 'rival_tenant_template',
    bodyText: 'This must never appear in another tenant’s composer.',
  }),
];

// --- Tickets (TAR-25), and the supervisor's deferred queue (TAR-23) --------
//
// Five in the main tenant, chosen so every branch of the queue and the ticket
// view is reachable without editing a fixture: the sort (urgent above high above
// normal), the active-only default (two terminal tickets that must not appear in
// it), `scope=unassigned` (which needs `ticket:read_all`), and a ticket closed
// without a resolution.
//
// They also respect `tickets_one_active_per_contact`: Fatima and Mei each hold
// exactly one *active* ticket, and their second one is terminal. A fixture set
// that broke the invariant would let a bug through that the database refuses.
//
// Three more carry the deferred queue — one per reason in ADR 0008's vocabulary,
// because a set holding only `all_at_capacity` would leave two thirds of the copy
// that tells a supervisor *who* must act unreachable in mock mode. They hang off
// contacts of their own, for the same invariant, and their `deferredSince` values
// are literals spread across a morning so oldest-stuck-first is something the view
// can be checked against rather than array order in disguise.

/**
 * `not_applicable` — the honest answer for a tenant with no active SLA policy,
 * and for a timer cancelled with its ticket (ADR 0006's lifecycle). Kept as the
 * default so a fixture that says nothing about SLA still renders a valid state.
 */
const NO_SLA: TicketSla = {
  policyId: null,
  firstResponseState: 'not_applicable',
  firstResponseDueAt: null,
  resolutionState: 'not_applicable',
  resolutionDueAt: null,
};

/**
 * What routing says about a ticket it has not reached a conclusion on (ADR 0008
 * decision 3). Every fixture below is `pending` because nothing writes the
 * column until TAR-288's router does; TAR-274's supervisor view overrides it to
 * `deferred` with a reason on the tickets it needs stuck.
 */
const NOT_ROUTED: TicketRouting = {
  state: 'pending',
  deferredReason: null,
  deferredSince: null,
};

/** `…010`, continuing the one-prefix-per-entity-type rule; see `SLA_ALERT_IDS`. */
const SLA_POLICY_ID = '0192f010-0000-7000-8000-000000001001';

/**
 * A deadline that has not passed, so `running` and `paused` are reachable in
 * mock mode.
 *
 * Same reasoning — and the same visible consequence — as `OPEN_SERVICE_WINDOW`
 * above: a deadline is *relative to now* by definition, and a literal is either
 * near enough to have passed by the time somebody looks or far enough not to,
 * which is this. It has to stay a literal, because a generated timestamp would
 * make server and client render different markup.
 *
 * ⚠️ The consequence is visible and is **not a bug in the countdown**: the
 * queue's SLA column reads "Due · in 26,440 days" in mock mode. A real
 * first-response window is 60 minutes and reads in minutes.
 */
const SLA_DEADLINE_AHEAD = '2099-01-01T01:00:00.000Z';

/** One hour after the ticket was opened, and missed. The breach the sweep found. */
const SLA_DEADLINE_MISSED = '2026-08-09T15:05:00.000Z';

/** Met with time to spare, on the ticket that was resolved. */
const SLA_DEADLINE_MET = '2026-08-01T10:00:00.000Z';

/** `first_response` only: the seeded policy leaves `resolutionMinutes` null. */
function firstResponseSla(state: TicketSla['firstResponseState'], dueAt: string | null): TicketSla {
  return {
    policyId: SLA_POLICY_ID,
    firstResponseState: state,
    firstResponseDueAt: dueAt,
    resolutionState: 'not_applicable',
    resolutionDueAt: null,
  };
}

function ticket(
  overrides: Partial<MockTicket> &
    Pick<MockTicket, 'id' | 'number' | 'status' | 'priority' | 'createdAt'>,
): MockTicket {
  return {
    tenantId: MOCK_TENANT_ID,
    conversationId: null,
    contactId: null,
    // Null on every auto-created ticket: the first inbound message is as likely
    // to be a photo as a sentence, so there is nothing honest to derive a
    // subject from. The console falls back to the number.
    subject: null,
    assignedUserId: null,
    assignedTeamId: null,
    routing: NOT_ROUTED,
    sla: NO_SLA,
    firstRespondedAt: null,
    // Both null by default: a ticket nobody has answered has nobody to credit,
    // and a fixture that guessed would teach the dashboard an attribution the
    // product does not have.
    firstResponseUserId: null,
    resolvedByUserId: null,
    resolvedAt: null,
    closedAt: null,
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

export const MOCK_TICKETS: readonly MockTicket[] = [
  ticket({
    id: TICKET_IDS.fatimaUrgent,
    number: 1042,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    contactId: CONTACT_IDS.fatima,
    subject: 'July invoice never arrived',
    status: 'open',
    priority: 'urgent',
    assignedUserId: USER_IDS.amina,
    assignedTeamId: TEAM_IDS.billing,
    // The overdue one, and the only one: a queue where every row is flagged has
    // flagged nothing. It is what `?overdue=true` narrows to, what the row rule
    // is drawn beside, and what the supervisor's alert below points at.
    sla: firstResponseSla('breached', SLA_DEADLINE_MISSED),
    createdAt: '2026-08-09T14:05:00.000Z',
    // Answered, but an hour and a half past the deadline — which is what a
    // breached timer with a response against it looks like, and gives the
    // dashboard its slowest first response.
    firstRespondedAt: '2026-08-09T16:40:00.000Z',
    firstResponseUserId: USER_IDS.amina,
    updatedAt: '2026-08-10T08:45:00.000Z',
  }),
  ticket({
    id: TICKET_IDS.jonasPending,
    number: 1039,
    conversationId: CONVERSATION_IDS.billingTeam,
    contactId: CONTACT_IDS.jonas,
    // No subject, so the queue's `Ticket #1039` fallback is reachable.
    status: 'pending',
    priority: 'normal',
    assignedTeamId: TEAM_IDS.billing,
    // `pending` pauses the timer (`TICKET_STATUS_PAUSES_SLA`), so this is the
    // one row that proves a waiting-on-customer ticket does not quietly breach.
    sla: firstResponseSla('paused', SLA_DEADLINE_AHEAD),
    createdAt: '2026-08-08T11:05:00.000Z',
    updatedAt: '2026-08-10T06:30:00.000Z',
  }),
  ticket({
    id: TICKET_IDS.meiUnassigned,
    number: 1036,
    conversationId: CONVERSATION_IDS.assignedToLiang,
    contactId: CONTACT_IDS.mei,
    subject: 'Activation link keeps expiring',
    status: 'open',
    priority: 'high',
    // Held by nobody: triaged work, which is why `unassigned` needs
    // `ticket:read_all` rather than being open to every agent the way an
    // unclaimed *conversation* is.
    sla: firstResponseSla('running', SLA_DEADLINE_AHEAD),
    createdAt: '2026-08-07T09:05:00.000Z',
    updatedAt: '2026-08-09T22:10:00.000Z',
  }),
  ticket({
    id: TICKET_IDS.fatimaResolved,
    number: 1011,
    conversationId: CONVERSATION_IDS.assignedToAmina,
    contactId: CONTACT_IDS.fatima,
    subject: 'Refund for the duplicate charge',
    status: 'resolved',
    priority: 'normal',
    assignedUserId: USER_IDS.amina,
    assignedTeamId: TEAM_IDS.billing,
    // Answered in time. `met` is terminal too, and stays visible under
    // `?status=resolved` so the success case is not only inferable from absence.
    sla: firstResponseSla('met', SLA_DEADLINE_MET),
    createdAt: '2026-08-01T09:00:00.000Z',
    firstRespondedAt: '2026-08-01T09:35:00.000Z',
    firstResponseUserId: USER_IDS.amina,
    resolvedAt: '2026-08-05T15:20:00.000Z',
    // Answered by Amina and finished by the supervisor: attribution follows the
    // work rather than the assignment, which is the property ADR 0009 decision 4
    // exists for and the one a per-agent table gets wrong by default.
    resolvedByUserId: USER_IDS.priya,
    updatedAt: '2026-08-05T15:20:00.000Z',
  }),
  ticket({
    id: TICKET_IDS.meiClosed,
    number: 1004,
    conversationId: CONVERSATION_IDS.assignedToLiang,
    contactId: CONTACT_IDS.mei,
    subject: 'Wrong number',
    status: 'closed',
    priority: 'low',
    assignedUserId: USER_IDS.liang,
    assignedTeamId: TEAM_IDS.onboarding,
    createdAt: '2026-07-20T08:00:00.000Z',
    // Somebody replied, and who is not recorded — a ticket that predates the
    // attribution column, which is what the backfill leaves behind when the
    // evidence is missing. It lands in the report's unattributed row rather than
    // being redistributed, and it is the fixture that makes that row reachable.
    firstRespondedAt: '2026-07-20T08:45:00.000Z',
    firstResponseUserId: null,
    // `resolvedAt` stays null on purpose: closing a wrong number is not a
    // resolution, and back-filling one would manufacture a cycle time that never
    // happened (ADR 0006 §3).
    closedAt: '2026-07-25T10:30:00.000Z',
    updatedAt: '2026-07-25T10:30:00.000Z',
  }),
  ticket({
    id: TICKET_IDS.jonasResolvedThenClosed,
    number: 1021,
    conversationId: CONVERSATION_IDS.billingTeam,
    contactId: CONTACT_IDS.jonas,
    subject: 'Duplicate subscription charge',
    // Terminal, and terminal twice over: resolved on the 30th, closed on the
    // 2nd. Absent from every queue, present in the dashboard's resolved volume.
    status: 'closed',
    priority: 'normal',
    assignedUserId: USER_IDS.liang,
    assignedTeamId: TEAM_IDS.onboarding,
    sla: firstResponseSla('met', '2026-07-28T10:00:00.000Z'),
    createdAt: '2026-07-28T09:00:00.000Z',
    firstRespondedAt: '2026-07-28T09:12:00.000Z',
    firstResponseUserId: USER_IDS.liang,
    resolvedAt: '2026-07-30T11:00:00.000Z',
    resolvedByUserId: USER_IDS.liang,
    closedAt: '2026-08-02T09:00:00.000Z',
    updatedAt: '2026-08-02T09:00:00.000Z',
  }),
  ticket({
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: TICKET_IDS.otherTenant,
    number: 7,
    conversationId: CONVERSATION_IDS.otherTenant,
    contactId: CONTACT_IDS.otherTenant,
    subject: 'This must never appear in another tenant’s queue',
    status: 'open',
    priority: 'urgent',
    assignedUserId: USER_IDS.otherTenant,
    // Breached, so `?overdue=true` has something to leak if the scoping is wrong.
    sla: firstResponseSla('breached', SLA_DEADLINE_MISSED),
    createdAt: '2026-06-02T09:05:00.000Z',
    // Answered a fortnight late, so the dashboard has something to leak too: a
    // reporting query that lost its tenant scope would move this tenant's
    // first-response numbers by days rather than by minutes.
    firstRespondedAt: '2026-06-16T09:05:00.000Z',
    firstResponseUserId: USER_IDS.otherTenant,
  }),

  // The deferred queue. Each hangs off a contact of its own so the five tickets
  // above keep their one-active-per-contact invariant, and each names a `routing`
  // explicitly — `defaultRouting` above only knows about tickets nothing deferred.
  ticket({
    id: TICKET_IDS.deferredAtCapacity,
    number: 1041,
    contactId: CONTACT_IDS.sofia,
    subject: 'Refund still not showing on the card',
    status: 'open',
    priority: 'high',
    // Routed to Billing by rule, and then nobody in Billing had room.
    assignedTeamId: TEAM_IDS.billing,
    routing: {
      state: 'deferred',
      deferredReason: 'all_at_capacity',
      deferredSince: '2026-08-10T07:12:00.000Z',
    },
    createdAt: '2026-08-10T07:10:00.000Z',
    updatedAt: '2026-08-10T07:12:00.000Z',
  }),
  ticket({
    id: TICKET_IDS.deferredNoneAvailable,
    number: 1043,
    contactId: CONTACT_IDS.karim,
    subject: 'Cannot complete activation',
    status: 'open',
    priority: 'normal',
    assignedTeamId: TEAM_IDS.onboarding,
    routing: {
      state: 'deferred',
      deferredReason: 'none_available',
      deferredSince: '2026-08-10T08:05:00.000Z',
    },
    createdAt: '2026-08-10T08:03:00.000Z',
    updatedAt: '2026-08-10T08:05:00.000Z',
  }),
  ticket({
    id: TICKET_IDS.deferredNoCandidatePool,
    number: 1044,
    contactId: CONTACT_IDS.yuki,
    // Deliberately no subject: an auto-created ticket has nothing honest to
    // derive one from, so the view has to fall back to the ticket number.
    status: 'open',
    priority: 'normal',
    routing: {
      state: 'deferred',
      deferredReason: 'no_candidate_pool',
      deferredSince: '2026-08-10T09:20:00.000Z',
    },
    createdAt: '2026-08-10T09:18:00.000Z',
    updatedAt: '2026-08-10T09:20:00.000Z',
  }),
  ticket({
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: TICKET_IDS.otherTenantDeferred,
    number: 8,
    contactId: CONTACT_IDS.otherTenant,
    subject: 'This must never appear in another tenant’s flagged queue',
    status: 'open',
    priority: 'normal',
    routing: {
      state: 'deferred',
      deferredReason: 'all_at_capacity',
      deferredSince: '2026-08-10T06:00:00.000Z',
    },
    createdAt: '2026-06-02T09:10:00.000Z',
  }),
];

/**
 * The tenant's tag vocabulary, which a `tag` routing condition picks ids from.
 * TAR-33 owns the editor; these exist so TAR-289's condition builder has real ids
 * to offer instead of asking a supervisor to type a UUID.
 */
export const MOCK_TAGS: readonly MockTag[] = [
  { tenantId: MOCK_TENANT_ID, id: TAG_IDS.vip, name: 'VIP', color: '#7c3aed' },
  {
    tenantId: MOCK_TENANT_ID,
    id: TAG_IDS.refundRequested,
    name: 'Refund requested',
    color: '#dc2626',
  },
  { tenantId: MOCK_TENANT_ID, id: TAG_IDS.escalated, name: 'Escalated', color: '#ea580c' },
  {
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: TAG_IDS.otherTenant,
    name: 'Rival tenant tag',
    color: '#0ea5e9',
  },
];

/**
 * What a `contact_attribute` condition's `key` may name, and — since 0002
 * amendment 10 — what the contact profile renders, in `position` order.
 */
export const MOCK_CUSTOM_FIELD_DEFINITIONS: readonly MockCustomFieldDefinition[] = [
  {
    tenantId: MOCK_TENANT_ID,
    id: CUSTOM_FIELD_IDS.planTier,
    key: 'plan_tier',
    label: 'Plan tier',
    type: 'select',
    options: ['bronze', 'silver', 'gold'],
    position: 0,
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: CUSTOM_FIELD_IDS.accountManager,
    key: 'account_manager',
    label: 'Account manager',
    type: 'text',
    options: [],
    position: 1,
    createdAt: '2026-06-01T09:05:00.000Z',
    updatedAt: '2026-06-01T09:05:00.000Z',
  },
  {
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: CUSTOM_FIELD_IDS.otherTenant,
    key: 'rival_field',
    label: 'Rival tenant field',
    type: 'text',
    options: [],
    position: 0,
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
  },
];

/**
 * Routing rules in evaluation order, seeded so the list surface has an order to
 * demonstrate rather than one row.
 *
 * `orphaned` is the state 0007 calls out and the console has to handle: a rule
 * whose target user was removed keeps its conditions, loses its target and is
 * left inactive, so a supervisor finds a rule needing a new target rather than
 * finding it silently gone.
 */
export const MOCK_ASSIGNMENT_RULES: readonly MockAssignmentRule[] = [
  {
    tenantId: MOCK_TENANT_ID,
    id: ASSIGNMENT_RULE_IDS.billingKeywords,
    name: 'Billing keywords',
    position: 0,
    isActive: true,
    conditions: [{ type: 'keyword', match: 'any', values: ['billing', 'invoice', 'refund'] }],
    target: { kind: 'team', teamId: TEAM_IDS.billing },
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:00:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: ASSIGNMENT_RULE_IDS.outOfHours,
    name: 'Out of hours',
    position: 1,
    isActive: true,
    conditions: [{ type: 'business_hours', within: false }],
    target: { kind: 'user', userId: USER_IDS.priya },
    createdAt: '2026-08-10T09:05:00.000Z',
    updatedAt: '2026-08-10T09:05:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: ASSIGNMENT_RULE_IDS.vipContacts,
    name: 'VIP onboarding',
    position: 2,
    isActive: false,
    conditions: [
      { type: 'tag', match: 'any', tagIds: [TAG_IDS.vip] },
      { type: 'contact_attribute', key: 'plan_tier', operator: 'equals', value: 'gold' },
    ],
    target: { kind: 'team', teamId: TEAM_IDS.onboarding },
    createdAt: '2026-08-10T09:10:00.000Z',
    updatedAt: '2026-08-11T14:20:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: ASSIGNMENT_RULE_IDS.orphaned,
    name: 'Escalations (needs a new target)',
    position: 3,
    isActive: false,
    conditions: [{ type: 'keyword', match: 'all', values: ['urgent'] }],
    target: null,
    createdAt: '2026-08-10T09:15:00.000Z',
    updatedAt: '2026-08-12T08:00:00.000Z',
  },
  {
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: ASSIGNMENT_RULE_IDS.otherTenant,
    name: 'Rival tenant routing',
    position: 0,
    isActive: true,
    conditions: [{ type: 'keyword', match: 'any', values: ['southwind'] }],
    target: { kind: 'team', teamId: TEAM_IDS.otherTenant },
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:00:00.000Z',
  },
];

// --- Ticket events (TAR-32, ADR 0011 decision 4) -----------------------------
//
// The append-only per-ticket trail the history view reads. Seeded on Fatima's
// urgent ticket only, so the surface has one ticket with a real story on it and
// the rest genuinely render the empty state — a fixture set where every ticket
// has a history would hide it.
//
// The story is the one TAR-32 is about, in order: opened, routed to Billing by a
// rule, handed from Liang to Amina with a reason, then escalated when the refund
// decision needed somebody senior. It covers every branch the renderer has:
// an actor and no actor, a reason and no reason, an assignment on both sides, an
// escalation addressed to a person and one addressed to nobody in particular.
//
// The prefix continues the file's one-per-entity-type rule: `…010`, after the
// SLA timers' `…00f`.

const TICKET_EVENT_IDS = {
  fatimaCreated: '0192f010-0000-7000-8000-000000001001',
  fatimaRouted: '0192f010-0000-7000-8000-000000001002',
  fatimaReassigned: '0192f010-0000-7000-8000-000000001003',
  fatimaEscalatedToPriya: '0192f010-0000-7000-8000-000000001004',
  fatimaEscalatedToNobody: '0192f010-0000-7000-8000-000000001005',
  otherTenant: '0192f010-0000-7000-8000-000000001099',
} as const;

const NO_ASSIGNMENT = {
  fromUserId: null,
  fromTeamId: null,
  toUserId: null,
  toTeamId: null,
} as const;

function ticketEvent(
  overrides: Pick<MockTicketEvent, 'id' | 'ticketId' | 'type' | 'createdAt'> &
    Partial<MockTicketEvent>,
): MockTicketEvent {
  return {
    tenantId: MOCK_TENANT_ID,
    actorUserId: null,
    fromValue: null,
    toValue: null,
    assignment: null,
    reason: null,
    cause: null,
    ...overrides,
  };
}

export const MOCK_TICKET_EVENTS: readonly MockTicketEvent[] = [
  ticketEvent({
    id: TICKET_EVENT_IDS.fatimaCreated,
    ticketId: TICKET_IDS.fatimaUrgent,
    type: 'created',
    // No actor and no cause: the auto-linker opened it when Fatima wrote in.
    createdAt: '2026-08-09T14:05:00.000Z',
  }),
  ticketEvent({
    id: TICKET_EVENT_IDS.fatimaRouted,
    ticketId: TICKET_IDS.fatimaUrgent,
    type: 'assigned',
    // Routing's own write, so `automation` rather than `agent` — the badge that
    // distinguishes "a rule did this" from "a person did this".
    cause: 'automation',
    assignment: { ...NO_ASSIGNMENT, toUserId: USER_IDS.liang, toTeamId: TEAM_IDS.billing },
    createdAt: '2026-08-09T14:05:02.000Z',
  }),
  ticketEvent({
    id: TICKET_EVENT_IDS.fatimaReassigned,
    ticketId: TICKET_IDS.fatimaUrgent,
    // A reassignment is an `assigned` whose previous holder happened to be
    // non-null — not a third type, which would make every consumer learn all
    // three (ADR 0011 decision 4).
    type: 'assigned',
    actorUserId: USER_IDS.liang,
    cause: 'agent',
    assignment: {
      fromUserId: USER_IDS.liang,
      fromTeamId: TEAM_IDS.billing,
      toUserId: USER_IDS.amina,
      toTeamId: TEAM_IDS.billing,
    },
    reason: 'Going off shift and Amina has the refund history on this account.',
    createdAt: '2026-08-09T16:40:00.000Z',
  }),
  ticketEvent({
    id: TICKET_EVENT_IDS.fatimaEscalatedToPriya,
    ticketId: TICKET_IDS.fatimaUrgent,
    type: 'escalated',
    actorUserId: USER_IDS.amina,
    cause: 'agent',
    // Addressed to a named supervisor: `toValue` carries the id.
    toValue: USER_IDS.priya,
    reason: 'Customer is threatening a chargeback and wants a refund decision today.',
    createdAt: '2026-08-10T08:45:00.000Z',
  }),
  ticketEvent({
    id: TICKET_EVENT_IDS.fatimaEscalatedToNobody,
    ticketId: TICKET_IDS.fatimaUrgent,
    type: 'escalated',
    actorUserId: USER_IDS.amina,
    cause: 'agent',
    // `toValue` null on purpose, and it is meaningful rather than missing: the
    // escalation went to whoever supervises this ticket rather than to a person.
    // Re-escalation is allowed, so a second one an hour later is legitimate.
    reason: 'Still nothing back — raising it again to whoever is covering Billing.',
    createdAt: '2026-08-10T09:50:00.000Z',
  }),
  ticketEvent({
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: TICKET_EVENT_IDS.otherTenant,
    ticketId: TICKET_IDS.otherTenant,
    type: 'escalated',
    actorUserId: USER_IDS.otherTenant,
    cause: 'agent',
    reason: 'This must never appear in another tenant’s history.',
    createdAt: '2026-06-02T09:30:00.000Z',
  }),
];

// --- SLA alerts (TAR-26) ----------------------------------------------------
//
// One row per recipient per breached timer, which is what makes them the
// delivery record *and* the idempotency ledger (ADR 0006 decision 5). Three
// here, chosen so the two rules the console rests on are testable:
//
//   1. **Narrowing to the caller.** Priya and Omar each hold their own row for
//      the same breach — decision 4 resolves *every* active supervisor and
//      admin, not one of them — so a panel that forgot to narrow would show
//      Priya somebody else's copy.
//   2. **Tenant scoping**, via the row in the second tenant.
//
// The prefixes continue the file's one-per-entity-type rule from routing's
// `…00d`: alerts take `…00e` and the timers behind them `…00f`. They were
// `…00c`/`…00d` before TAR-289 landed and claimed those for custom fields and
// assignment rules — a collision git merges without a word, and the whole point
// of the convention is that an id in a failing assertion says which fixture it
// came from.

const SLA_ALERT_IDS = {
  priyaFatimaUrgent: '0192f00e-0000-7000-8000-000000000e01',
  omarFatimaUrgent: '0192f00e-0000-7000-8000-000000000e02',
  otherTenant: '0192f00e-0000-7000-8000-000000000e99',
} as const;

/** The timer the alerts were raised from. One timer, two recipients, two rows. */
const SLA_TIMER_IDS = {
  fatimaUrgentFirstResponse: '0192f00f-0000-7000-8000-000000000f01',
  otherTenantFirstResponse: '0192f00f-0000-7000-8000-000000000f99',
} as const;

export const MOCK_SLA_ALERTS: readonly MockSlaAlert[] = [
  {
    tenantId: MOCK_TENANT_ID,
    id: SLA_ALERT_IDS.priyaFatimaUrgent,
    recipientUserId: USER_IDS.priya,
    ticketId: TICKET_IDS.fatimaUrgent,
    ticketNumber: 1042,
    slaTimerId: SLA_TIMER_IDS.fatimaUrgentFirstResponse,
    kind: 'first_response',
    dueAt: SLA_DEADLINE_MISSED,
    assignedUserId: USER_IDS.amina,
    assignedTeamId: TEAM_IDS.billing,
    acknowledgedAt: null,
    // Detected on the sweep after the deadline, not at the deadline.
    createdAt: '2026-08-09T15:05:30.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: SLA_ALERT_IDS.omarFatimaUrgent,
    recipientUserId: USER_IDS.omar,
    ticketId: TICKET_IDS.fatimaUrgent,
    ticketNumber: 1042,
    slaTimerId: SLA_TIMER_IDS.fatimaUrgentFirstResponse,
    kind: 'first_response',
    dueAt: SLA_DEADLINE_MISSED,
    assignedUserId: USER_IDS.amina,
    assignedTeamId: TEAM_IDS.billing,
    acknowledgedAt: null,
    createdAt: '2026-08-09T15:05:30.000Z',
  },
  {
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: SLA_ALERT_IDS.otherTenant,
    recipientUserId: USER_IDS.otherTenant,
    ticketId: TICKET_IDS.otherTenant,
    ticketNumber: 7,
    slaTimerId: SLA_TIMER_IDS.otherTenantFirstResponse,
    kind: 'first_response',
    dueAt: SLA_DEADLINE_MISSED,
    assignedUserId: USER_IDS.otherTenant,
    assignedTeamId: null,
    acknowledgedAt: null,
    createdAt: '2026-06-02T10:05:30.000Z',
  },
];

// --- Workflows (TAR-27, ADR 0009) -------------------------------------------
//
// The prefixes continue the file's one-per-entity-type rule. They were `…010`
// and `…011` on the branch that wrote them, and moved to `…012` and `…013` on
// the rebase: TAR-407 landed `SLA_POLICY_ID` on `…010` in the meantime, and two
// fixtures sharing an id is precisely the collision git merges without a word —
// which is what the convention exists to make visible.
//
// Three in this tenant, chosen so every state the console has to render is
// reachable without editing a fixture:
//
//   1. an armed elapsed-trigger workflow — TAR-27's own worked example;
//   2. an armed event-trigger workflow with a team target, so the two trigger
//      shapes and the reassign action are both visible;
//   3. one deactivated by the removal of a user it notified, which is the
//      broken-reference state ADR 0009 decision 6 makes visible rather than
//      silent. Its `userId` deliberately resolves to nobody.

const WORKFLOW_IDS = {
  escalateStale: '0192f012-0000-7000-8000-000000001201',
  urgentToBilling: '0192f012-0000-7000-8000-000000001202',
  /** Deactivated by the removal of the agent it notified, so it has a dead id. */
  brokenNotify: '0192f012-0000-7000-8000-000000001203',
  otherTenant: '0192f012-0000-7000-8000-000000001299',
} as const;

const WORKFLOW_RUN_IDS = {
  escalatedFatima: '0192f013-0000-7000-8000-000000001301',
  skippedJonas: '0192f013-0000-7000-8000-000000001302',
  failedMei: '0192f013-0000-7000-8000-000000001303',
  otherTenant: '0192f013-0000-7000-8000-000000001399',
} as const;

/** An agent who was removed after a workflow named them. Resolves to nobody. */
const REMOVED_USER_ID = '0192f001-0000-7000-8000-0000000001fe';

/**
 * `references` is **not** stored: ADR 0009 decision 6 resolves it live at read
 * time from the ids in the definition, so a rename needs no migration and a
 * delete shows as `exists: false`. Omitting it here is what keeps the mock
 * honest about that — `toWorkflowResponse` recomputes it on every read.
 */
export type MockWorkflow = Omit<WorkflowResponse, 'references'> & TenantScoped;
export type MockWorkflowRun = WorkflowRunResponse & TenantScoped;

export const MOCK_WORKFLOWS: readonly MockWorkflow[] = [
  {
    tenantId: MOCK_TENANT_ID,
    id: WORKFLOW_IDS.escalateStale,
    name: 'Escalate stale tickets',
    position: 0,
    isActive: true,
    brokenReason: null,
    version: 2,
    trigger: { type: 'ticket_unresolved_for', minutes: 240 },
    conditions: [{ type: 'ticket_status', operator: 'in', values: ['open', 'pending'] }],
    actions: [
      {
        type: 'notify',
        audience: 'supervisors',
        userId: null,
        teamId: null,
        message: 'Unresolved for 4 hours',
      },
      { type: 'add_ticket_tag', tagId: TAG_IDS.escalated },
    ],
    createdAt: '2026-08-12T09:00:00.000Z',
    updatedAt: '2026-08-13T11:30:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: WORKFLOW_IDS.urgentToBilling,
    name: 'Urgent tickets go to Billing',
    position: 1,
    isActive: true,
    brokenReason: null,
    version: 1,
    trigger: { type: 'ticket_created' },
    conditions: [{ type: 'ticket_priority', operator: 'in', values: ['urgent'] }],
    actions: [{ type: 'reassign', target: { kind: 'team', teamId: TEAM_IDS.billing } }],
    createdAt: '2026-08-12T09:05:00.000Z',
    updatedAt: '2026-08-12T09:05:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: WORKFLOW_IDS.brokenNotify,
    name: 'Tell Noor about breaches',
    position: 2,
    isActive: false,
    brokenReason: 'reference_removed',
    version: 1,
    trigger: { type: 'ticket_sla_breached' },
    conditions: [],
    actions: [
      {
        type: 'notify',
        audience: 'user',
        userId: REMOVED_USER_ID,
        teamId: null,
        message: null,
      },
    ],
    createdAt: '2026-08-12T09:10:00.000Z',
    updatedAt: '2026-08-14T16:45:00.000Z',
  },
  {
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: WORKFLOW_IDS.otherTenant,
    name: 'Rival tenant automation',
    position: 0,
    isActive: true,
    brokenReason: null,
    version: 1,
    trigger: { type: 'ticket_created' },
    conditions: [],
    actions: [{ type: 'set_priority', priority: 'high' }],
    createdAt: '2026-08-12T09:00:00.000Z',
    updatedAt: '2026-08-12T09:00:00.000Z',
  },
];

/**
 * Three runs of the escalation workflow, one per outcome the run panel has to
 * render: it ran and changed something, it ran and its conditions did not match,
 * and it failed. A fixture set holding only successes would leave two thirds of
 * that panel — and the copy that explains a failure — unreachable.
 */
export const MOCK_WORKFLOW_RUNS: readonly MockWorkflowRun[] = [
  {
    tenantId: MOCK_TENANT_ID,
    id: WORKFLOW_RUN_IDS.escalatedFatima,
    workflowId: WORKFLOW_IDS.escalateStale,
    workflowVersion: 2,
    ticketId: TICKET_IDS.fatimaUrgent,
    ticketNumber: 1042,
    status: 'succeeded',
    triggerType: 'ticket_unresolved_for',
    results: [
      { index: 0, type: 'notify', outcome: 'applied', reason: null },
      { index: 1, type: 'add_ticket_tag', outcome: 'applied', reason: null },
    ],
    failureReason: null,
    startedAt: '2026-08-14T13:00:01.000Z',
    finishedAt: '2026-08-14T13:00:02.000Z',
    createdAt: '2026-08-14T13:00:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: WORKFLOW_RUN_IDS.skippedJonas,
    workflowId: WORKFLOW_IDS.escalateStale,
    workflowVersion: 2,
    ticketId: TICKET_IDS.jonasPending,
    ticketNumber: 1043,
    status: 'skipped',
    triggerType: 'ticket_unresolved_for',
    // Empty on `skipped`: nothing was attempted, which is the point.
    results: [],
    failureReason: null,
    startedAt: '2026-08-14T12:00:01.000Z',
    finishedAt: '2026-08-14T12:00:01.000Z',
    createdAt: '2026-08-14T12:00:00.000Z',
  },
  {
    tenantId: MOCK_TENANT_ID,
    id: WORKFLOW_RUN_IDS.failedMei,
    workflowId: WORKFLOW_IDS.escalateStale,
    workflowVersion: 1,
    ticketId: TICKET_IDS.meiClosed,
    ticketNumber: 1044,
    status: 'failed',
    triggerType: 'ticket_unresolved_for',
    // The first action succeeded and stayed done; the second stopped the run.
    results: [
      { index: 0, type: 'notify', outcome: 'applied', reason: null },
      { index: 1, type: 'add_ticket_tag', outcome: 'failed', reason: 'reference_missing' },
    ],
    failureReason: 'reference_missing',
    startedAt: '2026-08-13T18:00:01.000Z',
    finishedAt: '2026-08-13T18:00:02.000Z',
    createdAt: '2026-08-13T18:00:00.000Z',
  },
  {
    // Present only so tenant scoping can be asserted, never rendered.
    tenantId: OTHER_TENANT_ID,
    id: WORKFLOW_RUN_IDS.otherTenant,
    workflowId: WORKFLOW_IDS.otherTenant,
    workflowVersion: 1,
    ticketId: TICKET_IDS.otherTenant,
    ticketNumber: 7,
    status: 'succeeded',
    triggerType: 'ticket_created',
    results: [{ index: 0, type: 'set_priority', outcome: 'applied', reason: null }],
    failureReason: null,
    startedAt: '2026-08-12T10:00:01.000Z',
    finishedAt: '2026-08-12T10:00:02.000Z',
    createdAt: '2026-08-12T10:00:00.000Z',
  },
];

export const MOCK_IDS = {
  teams: TEAM_IDS,
  users: USER_IDS,
  contacts: CONTACT_IDS,
  conversations: CONVERSATION_IDS,
  messages: MESSAGE_IDS,
  notes: NOTE_IDS,
  templates: TEMPLATE_IDS,
  tickets: TICKET_IDS,
  ticketEvents: TICKET_EVENT_IDS,
  tags: TAG_IDS,
  customFields: CUSTOM_FIELD_IDS,
  assignmentRules: ASSIGNMENT_RULE_IDS,
  slaAlerts: SLA_ALERT_IDS,
  tenantDomains: TENANT_DOMAIN_IDS,
  workflows: WORKFLOW_IDS,
  workflowRuns: WORKFLOW_RUN_IDS,
  /** The agent a workflow still names and who no longer exists. */
  removedUser: REMOVED_USER_ID,
  whatsappAccount: WHATSAPP_ACCOUNT_ID,
} as const;
