import type {
  ConversationResponse,
  TeamResponse,
  TenantRole,
  UserResponse,
} from '@whatsappcrm/contracts';

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
  otherTenant: '0192f003-0000-7000-8000-000000000399',
} as const;

const CONVERSATION_IDS = {
  assignedToAmina: '0192f004-0000-7000-8000-000000000401',
  billingTeam: '0192f004-0000-7000-8000-000000000402',
  assignedToLiang: '0192f004-0000-7000-8000-000000000403',
  unassigned: '0192f004-0000-7000-8000-000000000404',
  otherTenant: '0192f004-0000-7000-8000-000000000499',
} as const;

const WHATSAPP_ACCOUNT_ID = '0192f005-0000-7000-8000-000000000501';

/** A record is only ever read through a handler that filters on this field. */
export interface TenantScoped {
  readonly tenantId: string;
}

export type MockUser = UserResponse & TenantScoped;
export type MockTeam = TeamResponse & TenantScoped;
export type MockConversation = ConversationResponse & TenantScoped;

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
    ticketId: null,
    unreadCount: 2,
    serviceWindowExpiresAt: '2026-08-11T09:00:00.000Z',
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
    ticketId: null,
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
    ticketId: null,
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

export const MOCK_IDS = {
  teams: TEAM_IDS,
  users: USER_IDS,
  conversations: CONVERSATION_IDS,
} as const;
