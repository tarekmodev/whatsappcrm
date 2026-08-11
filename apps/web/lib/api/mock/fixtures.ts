import type {
  ConversationResponse,
  InternalNoteResponse,
  MessageAttachment,
  MessageResponse,
  TeamResponse,
  TenantRole,
  UserResponse,
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
export type MockMessage = MessageResponse & TenantScoped;
export type MockInternalNote = InternalNoteResponse & TenantScoped;

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

export const MOCK_IDS = {
  teams: TEAM_IDS,
  users: USER_IDS,
  conversations: CONVERSATION_IDS,
  messages: MESSAGE_IDS,
  notes: NOTE_IDS,
} as const;
