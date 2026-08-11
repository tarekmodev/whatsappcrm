import { AUDIT_ACTIONS } from '../audit/audit.actions';
import type { Prisma } from '../generated/prisma/client';

/**
 * The demo dataset (TAR-46). Data only — `seed.ts` decides which client writes
 * it and in what order.
 *
 * ---------------------------------------------------------------------------
 * Two tenants, and the second one is not padding
 * ---------------------------------------------------------------------------
 *
 * `northwind` is the tenant a developer works in. `southwind` exists so that
 * **tenant isolation is something you can see rather than something you are
 * told**: every list in the console is served under RLS, and a bug that drops
 * the tenant predicate is invisible in a database holding one tenant. Its rows
 * are deliberately distinctive — a Southwind contact appearing in Northwind's
 * inbox is a defect you notice from across the room.
 *
 * `pnpm db:verify:rls` proves the same property in SQL against throwaway rows.
 * This is the version that survives the run and that QA can click through.
 *
 * ---------------------------------------------------------------------------
 * Ids are literals, and they are the console's literals
 * ---------------------------------------------------------------------------
 *
 * Every id here is fixed, so a bookmarked URL, a `psql` snippet in a bug report
 * and a screenshot all keep meaning across a re-seed. The user, team, contact,
 * conversation and WhatsApp-account ids are **the same values**
 * `apps/web/lib/api/mock/fixtures.ts` serves in mock mode, so turning
 * `NEXT_PUBLIC_USE_MOCK_API` off swaps the transport without changing a single
 * id the UI renders. Where this file and the mock disagree it is because the
 * database refuses the mock's shape — noted at each site.
 *
 * The one id this file does **not** fix is the tenant's own.
 * `TenantProvisioningService` generates it, and the seed goes through that
 * service rather than around it, so pinning it here would mean writing the
 * `tenants` row by hand and having two ways to create a tenant. Nothing needs
 * it pinned: a tenant is reached by hostname (`northwind.app.localhost`), which
 * *is* derived from a constant — the slug.
 *
 * They are UUIDv7-shaped (`…-7xxx-8xxx-…`) because `schema.prisma` generates
 * v7 everywhere and a v4 sitting among them would read as a different kind of
 * row. Grouped by entity in the third-from-last block so that a bare id in a log
 * line says what it is: `…-0000000001xx` is a user, `…-0000000004xx` a
 * conversation.
 *
 * ---------------------------------------------------------------------------
 * Timestamps are relative to the run
 * ---------------------------------------------------------------------------
 *
 * Built from one `now` captured at the start of the seed, never from literals.
 * A demo inbox whose newest message is dated last spring reads as broken, and —
 * the load-bearing half — Meta's 24-hour customer service window is a
 * *timestamp*: fixed dates would leave every thread outside its window, so the
 * composer would be template-only on a fresh seed and nobody could try a plain
 * reply. One thread is deliberately left expired anyway, because that state also
 * has to be demonstrable.
 *
 * ---------------------------------------------------------------------------
 * No credentials, anywhere
 * ---------------------------------------------------------------------------
 *
 * `users.password_hash` is null on every seeded row: TAR-35 owns login and the
 * hash it writes, and a committed password hash is a committed password. The
 * per-WABA WhatsApp access token is the one secret-shaped value here, and it is
 * the string `SEED-PLACEHOLDER-NOT-A-REAL-TOKEN` encrypted at rest with the
 * local `WHATSAPP_TOKEN_ENCRYPTION_KEY` — enough for the connection to read as
 * connected and for the decrypt path to be exercised, and rejected by Meta the
 * moment anything tries to send with it. That is the intended failure: a local
 * stack must not be able to message a real customer.
 */

/**
 * Every tenant-scoped row is written without its own `tenant_id` and the writer
 * supplies one, uniformly, from the tenant it is currently seeding.
 *
 * The convention in `schema.prisma` is that the column is always there and
 * always explicit; the reason it is stripped *here* is that this file lists two
 * tenants' rows next to each other, and one mistyped literal in the middle of a
 * hundred would produce a row that RLS then hides from the tenant that was
 * supposed to own it — a silent gap in the demo rather than an error.
 */
type Scoped<T> = Omit<T, 'tenantId'>;

/** One tenant's worth of demo data, in dependency order. */
export interface DemoTenant {
  /**
   * The identity of the tenant, and the only thing about it the seed states:
   * `TenantProvisioningService` derives the id, the hostname and the settings
   * row from it, exactly as `POST /api/v1/admin/tenants` does.
   */
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly locale: string;
  /** Merged into the `tenant_settings` row provisioning already created. */
  readonly businessHours: Prisma.InputJsonValue;
  readonly branding: Scoped<Prisma.TenantBrandingCreateManyInput>;
  readonly subscription: {
    readonly planKey: string;
    readonly seats: number;
    readonly status: Prisma.SubscriptionCreateManyInput['status'];
  };
  readonly users: readonly Scoped<Prisma.UserCreateManyInput>[];
  readonly teams: readonly Scoped<Prisma.TeamCreateManyInput>[];
  readonly teamMembers: readonly Scoped<Prisma.TeamMemberCreateManyInput>[];
  readonly businessAccounts: readonly Scoped<Prisma.WhatsappBusinessAccountCreateManyInput>[];
  readonly whatsappAccounts: readonly Scoped<Prisma.WhatsappAccountCreateManyInput>[];
  readonly messageTemplates: readonly Scoped<Prisma.MessageTemplateCreateManyInput>[];
  readonly tags: readonly Scoped<Prisma.TagCreateManyInput>[];
  readonly customFieldDefs: readonly Scoped<Prisma.CustomFieldDefCreateManyInput>[];
  readonly contacts: readonly Scoped<Prisma.ContactCreateManyInput>[];
  readonly contactTags: readonly Scoped<Prisma.ContactTagCreateManyInput>[];
  readonly conversations: readonly Scoped<Prisma.ConversationCreateManyInput>[];
  readonly messages: readonly Scoped<Prisma.MessageCreateManyInput>[];
  readonly attachments: readonly Scoped<Prisma.MessageAttachmentCreateManyInput>[];
  readonly internalNotes: readonly Scoped<Prisma.InternalNoteCreateManyInput>[];
  readonly tickets: readonly Scoped<Prisma.TicketCreateManyInput>[];
  readonly ticketEvents: readonly Scoped<Prisma.TicketEventCreateManyInput>[];
  /**
   * What `ticket_counters` is left holding. It must be one past the highest
   * seeded `tickets.number`, or TAR-73's allocator hands out a number that
   * already exists and the next ticket created in the console fails on
   * `UNIQUE (tenant_id, number)`. Null for a tenant with no tickets: the row is
   * created lazily by the first one, and writing it here would seed a table
   * ahead of the flow that owns it.
   */
  readonly nextTicketNumber: number | null;
  /**
   * The period is omitted as well as the tenant: it is the *subscription's* own
   * window, which the seed reads once so that the counter and the subscription
   * row it is counted against cannot disagree.
   */
  readonly usageCounters: readonly Omit<
    Prisma.UsageCounterCreateManyInput,
    'tenantId' | 'periodStart' | 'periodEnd'
  >[];
  readonly auditLogs: readonly Scoped<Prisma.AuditLogCreateManyInput>[];
}

/** The plaintext behind every `whatsapp_business_accounts.access_token_encrypted`. */
export const DEMO_ACCESS_TOKEN = 'SEED-PLACEHOLDER-NOT-A-REAL-TOKEN';

export const DEMO_SLUGS = { northwind: 'northwind', southwind: 'southwind' } as const;

const USER_IDS = {
  amina: '0192f001-0000-7000-8000-000000000101',
  priya: '0192f001-0000-7000-8000-000000000102',
  omar: '0192f001-0000-7000-8000-000000000103',
  liang: '0192f001-0000-7000-8000-000000000104',
  noor: '0192f001-0000-7000-8000-000000000105',
  sofia: '0192f001-0000-7000-8000-000000000191',
  diego: '0192f001-0000-7000-8000-000000000192',
} as const;

const TEAM_IDS = {
  billing: '0192f002-0000-7000-8000-000000000201',
  onboarding: '0192f002-0000-7000-8000-000000000202',
  dispatch: '0192f002-0000-7000-8000-000000000291',
} as const;

const CONTACT_IDS = {
  fatima: '0192f003-0000-7000-8000-000000000301',
  jonas: '0192f003-0000-7000-8000-000000000302',
  mei: '0192f003-0000-7000-8000-000000000303',
  hector: '0192f003-0000-7000-8000-000000000304',
  carlos: '0192f003-0000-7000-8000-000000000391',
} as const;

const CONVERSATION_IDS = {
  fatimaInvoice: '0192f004-0000-7000-8000-000000000401',
  jonasDoubleCharge: '0192f004-0000-7000-8000-000000000402',
  meiActivation: '0192f004-0000-7000-8000-000000000403',
  fatimaOnboardingNumber: '0192f004-0000-7000-8000-000000000404',
  hectorOptOut: '0192f004-0000-7000-8000-000000000405',
  carlosFreight: '0192f004-0000-7000-8000-000000000491',
} as const;

const WHATSAPP_ACCOUNT_IDS = {
  /** The number the console's mock fixtures name, so both modes agree. */
  northwindCare: '0192f005-0000-7000-8000-000000000501',
  northwindOnboarding: '0192f005-0000-7000-8000-000000000502',
  southwindDispatch: '0192f005-0000-7000-8000-000000000591',
} as const;

const BUSINESS_ACCOUNT_IDS = {
  northwindTrading: '0192f006-0000-7000-8000-000000000601',
  northwindOnboarding: '0192f006-0000-7000-8000-000000000602',
  southwind: '0192f006-0000-7000-8000-000000000691',
} as const;

const MESSAGE_IDS = {
  fatima1: '0192f007-0000-7000-8000-000000000701',
  fatima2: '0192f007-0000-7000-8000-000000000702',
  fatima3: '0192f007-0000-7000-8000-000000000703',
  fatima4: '0192f007-0000-7000-8000-000000000704',
  fatima5: '0192f007-0000-7000-8000-000000000705',
  jonas1: '0192f007-0000-7000-8000-000000000711',
  jonas2: '0192f007-0000-7000-8000-000000000712',
  jonas3: '0192f007-0000-7000-8000-000000000713',
  mei1: '0192f007-0000-7000-8000-000000000721',
  mei2: '0192f007-0000-7000-8000-000000000722',
  walkIn1: '0192f007-0000-7000-8000-000000000731',
  hector1: '0192f007-0000-7000-8000-000000000741',
  hector2: '0192f007-0000-7000-8000-000000000742',
  carlos1: '0192f007-0000-7000-8000-000000000791',
  carlos2: '0192f007-0000-7000-8000-000000000792',
} as const;

const TICKET_IDS = {
  fatimaInvoice: '0192f008-0000-7000-8000-000000000801',
  hectorOptOut: '0192f008-0000-7000-8000-000000000802',
} as const;

const TAG_IDS = {
  vip: '0192f009-0000-7000-8000-000000000901',
  refund: '0192f009-0000-7000-8000-000000000902',
  churnRisk: '0192f009-0000-7000-8000-000000000903',
  priorityFreight: '0192f009-0000-7000-8000-000000000991',
} as const;

const TEMPLATE_IDS = {
  orderUpdate: '0192f00a-0000-7000-8000-000000000a01',
  appointmentReminder: '0192f00a-0000-7000-8000-000000000a02',
  paymentReceipt: '0192f00a-0000-7000-8000-000000000a03',
  autumnPromo: '0192f00a-0000-7000-8000-000000000a04',
  welcomeOnboarding: '0192f00a-0000-7000-8000-000000000a05',
  southwindEta: '0192f00a-0000-7000-8000-000000000a91',
} as const;

const PLAN_IDS = {
  starter: '0192f00b-0000-7000-8000-000000000b01',
  growth: '0192f00b-0000-7000-8000-000000000b02',
  scale: '0192f00b-0000-7000-8000-000000000b03',
} as const;

/** Everything with only one or two rows of its own kind. */
const MISC_IDS = {
  northwindBranding: '0192f00c-0000-7000-8000-000000000c01',
  southwindBranding: '0192f00c-0000-7000-8000-000000000c02',
  northwindSubscription: '0192f00c-0000-7000-8000-000000000c11',
  southwindSubscription: '0192f00c-0000-7000-8000-000000000c12',
  invoiceAttachment: '0192f00c-0000-7000-8000-000000000c21',
  noteCardChange: '0192f00c-0000-7000-8000-000000000c31',
  noteActivation: '0192f00c-0000-7000-8000-000000000c32',
  fieldAccountNumber: '0192f00c-0000-7000-8000-000000000c41',
  fieldPlanTier: '0192f00c-0000-7000-8000-000000000c42',
  contactTagFatimaVip: '0192f00c-0000-7000-8000-000000000c51',
  contactTagJonasRefund: '0192f00c-0000-7000-8000-000000000c52',
  contactTagMeiChurn: '0192f00c-0000-7000-8000-000000000c53',
  contactTagCarlosFreight: '0192f00c-0000-7000-8000-000000000c54',
  ticketEventInvoiceCreated: '0192f00c-0000-7000-8000-000000000c61',
  ticketEventInvoiceAssigned: '0192f00c-0000-7000-8000-000000000c62',
  ticketEventInvoicePriority: '0192f00c-0000-7000-8000-000000000c63',
  ticketEventOptOutCreated: '0192f00c-0000-7000-8000-000000000c64',
  ticketEventOptOutResolved: '0192f00c-0000-7000-8000-000000000c65',
  usageSeats: '0192f00c-0000-7000-8000-000000000c71',
  usageConversations: '0192f00c-0000-7000-8000-000000000c72',
  usageSeatsSouthwind: '0192f00c-0000-7000-8000-000000000c73',
  usageConversationsSouthwind: '0192f00c-0000-7000-8000-000000000c74',
  auditInviteNoor: '0192f00c-0000-7000-8000-000000000c81',
  auditPriyaRole: '0192f00c-0000-7000-8000-000000000c82',
  auditBillingTeam: '0192f00c-0000-7000-8000-000000000c83',
} as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function ago(now: Date, ms: number): Date {
  return new Date(now.getTime() - ms);
}

function ahead(now: Date, ms: number): Date {
  return new Date(now.getTime() + ms);
}

/**
 * The plan catalogue. Platform-wide rather than tenant-scoped, so it is written
 * once through `SystemPrisma` and shared — a tenant may read `plans` and may
 * never write it (`tenant-scope.extension.ts`, `shared-read-only`).
 *
 * `entitlements` carries the two quantities TAR-39's usage-counter interface
 * already names, and nothing else. The `FeatureGuard` that reads this column is
 * TAR-37's, and inventing a richer vocabulary here would fix its keys from a
 * seed file — the same reason `TenantProvisioningService` writes no branding
 * row. Prices are integer minor units against an ISO 4217 code, never a float.
 */
export const DEMO_PLANS: readonly Prisma.PlanCreateManyInput[] = [
  {
    id: PLAN_IDS.starter,
    key: 'starter',
    name: 'Starter',
    priceMinorUnits: 2900,
    currency: 'USD',
    interval: 'month',
    entitlements: { seats: 3, conversationsPerPeriod: 1_000 },
    isActive: true,
  },
  {
    id: PLAN_IDS.growth,
    key: 'growth',
    name: 'Growth',
    priceMinorUnits: 7900,
    currency: 'USD',
    interval: 'month',
    entitlements: { seats: 10, conversationsPerPeriod: 10_000 },
    isActive: true,
  },
  {
    id: PLAN_IDS.scale,
    key: 'scale',
    name: 'Scale',
    priceMinorUnits: 19900,
    currency: 'USD',
    interval: 'month',
    entitlements: { seats: 50, conversationsPerPeriod: 100_000 },
    isActive: true,
  },
];

/**
 * Meta's component tree for a template, stored verbatim the way the sync path
 * stores it. Written out rather than abbreviated because
 * `describeTemplateComponents` derives the composer's variable count from
 * exactly this shape, and a placeholder-free stub would make every seeded
 * template look parameterless.
 */
function orderUpdateComponents(): Prisma.InputJsonValue {
  return [
    { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' },
    {
      type: 'BODY',
      text: 'Hi {{1}}, your order {{2}} is now {{3}}. Reply here if anything looks wrong.',
    },
    { type: 'FOOTER', text: 'Northwind Trading' },
  ];
}

function appointmentReminderComponents(): Prisma.InputJsonValue {
  return [
    {
      type: 'BODY',
      text: 'Reminder: your appointment with {{1}} is on {{2}}. Reply RESCHEDULE to move it.',
    },
  ];
}

function paymentReceiptComponents(): Prisma.InputJsonValue {
  return [
    { type: 'BODY', text: 'Thanks — your payment has been received. Your receipt is attached.' },
    // A static url button: no placeholder and no `example`, so the send path
    // needs nothing for it and the template stays listable.
    {
      type: 'BUTTONS',
      buttons: [{ type: 'URL', text: 'View receipts', url: 'https://northwind.example/receipts' }],
    },
  ];
}

function welcomeComponents(): Prisma.InputJsonValue {
  return [
    { type: 'BODY', text: 'Welcome to {{1}}. Your account is ready — reply here to get started.' },
  ];
}

function northwind(now: Date): DemoTenant {
  return {
    slug: DEMO_SLUGS.northwind,
    name: 'Northwind Trading',
    timezone: 'Europe/London',
    locale: 'en-GB',
    businessHours: {
      mon: [{ from: '09:00', to: '17:00' }],
      tue: [{ from: '09:00', to: '17:00' }],
      wed: [{ from: '09:00', to: '17:00' }],
      thu: [{ from: '09:00', to: '17:00' }],
      fri: [{ from: '09:00', to: '16:00' }],
    },
    branding: {
      id: MISC_IDS.northwindBranding,
      productName: 'Northwind Care',
      primaryColor: '#0b6e4f',
      accentColor: '#f2a65a',
      supportEmail: 'support@northwind.example',
    },
    subscription: { planKey: 'growth', seats: 10, status: 'active' },

    // One user per role, plus a second agent and an invited one. The role
    // coverage is not decoration: with `AUTH_STUB_ENABLED=true` the interim
    // principal source looks up a real `users` row holding the role in the
    // cookie, so a tenant missing a supervisor answers 401 for every supervisor
    // request rather than showing an empty supervisor view.
    users: [
      {
        id: USER_IDS.omar,
        email: 'omar@northwind.example',
        name: 'Omar Farouk',
        role: 'admin',
        status: 'active',
        availability: 'away',
        lastSeenAt: ago(now, 2 * HOUR_MS),
        lastLoginAt: ago(now, 9 * HOUR_MS),
        createdAt: ago(now, 60 * DAY_MS),
      },
      {
        id: USER_IDS.priya,
        email: 'priya@northwind.example',
        name: 'Priya Raman',
        role: 'supervisor',
        status: 'active',
        availability: 'available',
        lastSeenAt: ago(now, 4 * MINUTE_MS),
        lastLoginAt: ago(now, 7 * HOUR_MS),
        createdAt: ago(now, 58 * DAY_MS),
      },
      {
        id: USER_IDS.amina,
        email: 'amina@northwind.example',
        name: 'Amina Haddad',
        role: 'agent',
        status: 'active',
        availability: 'available',
        lastSeenAt: ago(now, 2 * MINUTE_MS),
        lastLoginAt: ago(now, 6 * HOUR_MS),
        createdAt: ago(now, 58 * DAY_MS),
      },
      {
        id: USER_IDS.liang,
        email: 'liang@northwind.example',
        name: 'Liang Wei',
        role: 'agent',
        status: 'active',
        availability: 'offline',
        lastSeenAt: ago(now, 2 * DAY_MS),
        lastLoginAt: ago(now, 2 * DAY_MS),
        createdAt: ago(now, 40 * DAY_MS),
      },
      {
        // Invited and not yet accepted: no password hash, no availability, and
        // `occupiesSeat` false in the people list. The seat maths in the
        // subscription below only holds if one user is in this state.
        id: USER_IDS.noor,
        email: 'noor@northwind.example',
        name: 'Noor Sayed',
        role: 'agent',
        status: 'invited',
        availability: 'offline',
        createdAt: ago(now, 2 * DAY_MS),
      },
    ],

    teams: [
      {
        id: TEAM_IDS.billing,
        name: 'Billing',
        description: 'Payment, invoice and refund questions.',
        createdAt: ago(now, 57 * DAY_MS),
      },
      {
        id: TEAM_IDS.onboarding,
        name: 'Onboarding',
        description: 'New customer setup and activation.',
        createdAt: ago(now, 39 * DAY_MS),
      },
    ],

    // Priya is in both, which is what makes a supervisor's team-scoped view
    // wider than either agent's — the difference TAR-22's visibility predicate
    // is built around.
    teamMembers: [
      {
        id: '0192f00d-0000-7000-8000-000000000d01',
        teamId: TEAM_IDS.billing,
        userId: USER_IDS.amina,
      },
      {
        id: '0192f00d-0000-7000-8000-000000000d02',
        teamId: TEAM_IDS.billing,
        userId: USER_IDS.priya,
      },
      {
        id: '0192f00d-0000-7000-8000-000000000d03',
        teamId: TEAM_IDS.onboarding,
        userId: USER_IDS.priya,
      },
      {
        id: '0192f00d-0000-7000-8000-000000000d04',
        teamId: TEAM_IDS.onboarding,
        userId: USER_IDS.liang,
      },
    ],

    // Two WABAs under one tenant, which TAR-52 says is the real shape and which
    // a single-WABA seed would quietly hide: template approval is per WABA, so
    // `welcome_onboarding` below being approved under the second one and absent
    // from the first is the property to look at.
    businessAccounts: [
      {
        id: BUSINESS_ACCOUNT_IDS.northwindTrading,
        wabaId: '102030405060701',
        name: 'Northwind Trading Ltd',
        verificationStatus: 'verified',
        createdAt: ago(now, 55 * DAY_MS),
      },
      {
        id: BUSINESS_ACCOUNT_IDS.northwindOnboarding,
        wabaId: '102030405060702',
        name: 'Northwind Onboarding',
        verificationStatus: 'pending',
        createdAt: ago(now, 12 * DAY_MS),
      },
    ],

    whatsappAccounts: [
      {
        id: WHATSAPP_ACCOUNT_IDS.northwindCare,
        whatsappBusinessAccountId: BUSINESS_ACCOUNT_IDS.northwindTrading,
        phoneNumberId: '550055005500101',
        displayPhoneNumber: '+44 20 7946 0011',
        verifiedName: 'Northwind Care',
        qualityRating: 'green',
        status: 'connected',
        createdAt: ago(now, 55 * DAY_MS),
      },
      {
        // Yellow rather than green, because quality is rated per number and a
        // seed where both numbers are healthy makes the column look like it
        // belongs on the business account.
        id: WHATSAPP_ACCOUNT_IDS.northwindOnboarding,
        whatsappBusinessAccountId: BUSINESS_ACCOUNT_IDS.northwindOnboarding,
        phoneNumberId: '550055005500102',
        displayPhoneNumber: '+44 20 7946 0022',
        verifiedName: 'Northwind Onboarding',
        qualityRating: 'yellow',
        status: 'connected',
        createdAt: ago(now, 12 * DAY_MS),
      },
    ],

    messageTemplates: [
      {
        id: TEMPLATE_IDS.orderUpdate,
        whatsappBusinessAccountId: BUSINESS_ACCOUNT_IDS.northwindTrading,
        name: 'order_update',
        language: 'en_GB',
        category: 'UTILITY',
        status: 'approved',
        components: orderUpdateComponents(),
        providerTemplateId: '900000000000101',
        createdAt: ago(now, 50 * DAY_MS),
      },
      {
        id: TEMPLATE_IDS.appointmentReminder,
        whatsappBusinessAccountId: BUSINESS_ACCOUNT_IDS.northwindTrading,
        name: 'appointment_reminder',
        language: 'en_GB',
        category: 'UTILITY',
        status: 'approved',
        components: appointmentReminderComponents(),
        providerTemplateId: '900000000000102',
        createdAt: ago(now, 44 * DAY_MS),
      },
      {
        id: TEMPLATE_IDS.paymentReceipt,
        whatsappBusinessAccountId: BUSINESS_ACCOUNT_IDS.northwindTrading,
        name: 'payment_receipt',
        language: 'en_GB',
        category: 'UTILITY',
        status: 'approved',
        components: paymentReceiptComponents(),
        providerTemplateId: '900000000000103',
        createdAt: ago(now, 30 * DAY_MS),
      },
      {
        // Not approved, so it must not reach the composer's picker. A seed with
        // only approved templates cannot show that the filter is doing anything.
        id: TEMPLATE_IDS.autumnPromo,
        whatsappBusinessAccountId: BUSINESS_ACCOUNT_IDS.northwindTrading,
        name: 'autumn_promo',
        language: 'en_GB',
        category: 'MARKETING',
        status: 'pending',
        components: appointmentReminderComponents(),
        createdAt: ago(now, 3 * DAY_MS),
      },
      {
        id: TEMPLATE_IDS.welcomeOnboarding,
        whatsappBusinessAccountId: BUSINESS_ACCOUNT_IDS.northwindOnboarding,
        name: 'welcome_onboarding',
        language: 'en_GB',
        category: 'UTILITY',
        status: 'approved',
        components: welcomeComponents(),
        providerTemplateId: '900000000000105',
        createdAt: ago(now, 11 * DAY_MS),
      },
    ],

    tags: [
      { id: TAG_IDS.vip, name: 'VIP', color: '#f2a65a', createdAt: ago(now, 50 * DAY_MS) },
      { id: TAG_IDS.refund, name: 'Refund', color: '#d64545', createdAt: ago(now, 50 * DAY_MS) },
      {
        id: TAG_IDS.churnRisk,
        name: 'Churn risk',
        color: '#8b5cf6',
        createdAt: ago(now, 20 * DAY_MS),
      },
    ],

    customFieldDefs: [
      {
        id: MISC_IDS.fieldAccountNumber,
        key: 'account_number',
        label: 'Account number',
        type: 'text',
        position: 0,
        createdAt: ago(now, 50 * DAY_MS),
      },
      {
        id: MISC_IDS.fieldPlanTier,
        key: 'plan_tier',
        label: 'Plan tier',
        type: 'select',
        options: ['starter', 'growth', 'scale'],
        position: 1,
        createdAt: ago(now, 50 * DAY_MS),
      },
    ],

    contacts: [
      {
        id: CONTACT_IDS.fatima,
        phoneE164: '+966501234567',
        displayName: 'Fatima Al-Zahra',
        email: 'fatima@example.com',
        locale: 'ar',
        // Keys match `custom_field_defs.key` above. A value under a key with no
        // definition is legal in the column and invisible in the UI, which is
        // the mistake this pairing exists to make obvious.
        customFields: { account_number: 'NW-10021', plan_tier: 'growth' },
        lastSeenAt: ago(now, 15 * MINUTE_MS),
        createdAt: ago(now, 41 * DAY_MS),
      },
      {
        id: CONTACT_IDS.jonas,
        phoneE164: '+46701234567',
        displayName: 'Jonas Berg',
        email: 'jonas@example.com',
        locale: 'sv',
        customFields: { account_number: 'NW-10044', plan_tier: 'starter' },
        lastSeenAt: ago(now, 3 * HOUR_MS),
        createdAt: ago(now, 33 * DAY_MS),
      },
      {
        id: CONTACT_IDS.mei,
        phoneE164: '+81312345678',
        displayName: 'Mei Tanaka',
        locale: 'ja',
        customFields: { account_number: 'NW-10098', plan_tier: 'growth' },
        lastSeenAt: ago(now, 30 * HOUR_MS),
        createdAt: ago(now, 18 * DAY_MS),
      },
      {
        // Opted out. A non-null `opted_out_at` blocks outbound sends, and that
        // rule is unfalsifiable in a dataset where nobody has opted out.
        id: CONTACT_IDS.hector,
        phoneE164: '+34600123456',
        displayName: 'Héctor Ruiz',
        locale: 'es',
        optedOutAt: ago(now, 6 * DAY_MS),
        lastSeenAt: ago(now, 6 * DAY_MS),
        createdAt: ago(now, 25 * DAY_MS),
      },
    ],

    contactTags: [
      { id: MISC_IDS.contactTagFatimaVip, contactId: CONTACT_IDS.fatima, tagId: TAG_IDS.vip },
      { id: MISC_IDS.contactTagJonasRefund, contactId: CONTACT_IDS.jonas, tagId: TAG_IDS.refund },
      { id: MISC_IDS.contactTagMeiChurn, contactId: CONTACT_IDS.mei, tagId: TAG_IDS.churnRisk },
    ],

    conversations: [
      {
        // Assigned to an agent *and* a team, which is the case where the two
        // scoped inbox indexes disagree about who can see it.
        id: CONVERSATION_IDS.fatimaInvoice,
        whatsappAccountId: WHATSAPP_ACCOUNT_IDS.northwindCare,
        contactId: CONTACT_IDS.fatima,
        status: 'open',
        assignedUserId: USER_IDS.amina,
        assignedTeamId: TEAM_IDS.billing,
        unreadCount: 2,
        serviceWindowExpiresAt: ahead(now, 21 * HOUR_MS),
        lastMessageAt: ago(now, 15 * MINUTE_MS),
        createdAt: ago(now, 3 * HOUR_MS),
      },
      {
        // Team-assigned with nobody on it: the queue an agent picks from.
        id: CONVERSATION_IDS.jonasDoubleCharge,
        whatsappAccountId: WHATSAPP_ACCOUNT_IDS.northwindCare,
        contactId: CONTACT_IDS.jonas,
        status: 'pending',
        assignedTeamId: TEAM_IDS.billing,
        unreadCount: 0,
        serviceWindowExpiresAt: ahead(now, 18 * HOUR_MS),
        lastMessageAt: ago(now, 3 * HOUR_MS),
        createdAt: ago(now, 5 * HOUR_MS),
      },
      {
        // Service window already closed, so the composer must offer templates
        // only. Left expired on purpose — every other thread is inside its
        // window, and this is the state a fresh seed would otherwise never show.
        id: CONVERSATION_IDS.meiActivation,
        whatsappAccountId: WHATSAPP_ACCOUNT_IDS.northwindCare,
        contactId: CONTACT_IDS.mei,
        status: 'open',
        assignedUserId: USER_IDS.liang,
        assignedTeamId: TEAM_IDS.onboarding,
        unreadCount: 1,
        serviceWindowExpiresAt: ago(now, 6 * HOUR_MS),
        lastMessageAt: ago(now, 29 * HOUR_MS),
        createdAt: ago(now, 30 * HOUR_MS),
      },
      {
        // The same contact as the first thread, on the *other* number. That is
        // legal — the unique key is (tenant, whatsapp_account, contact) — and it
        // is why the console's mock, which puts both on one number, cannot be
        // copied here verbatim.
        id: CONVERSATION_IDS.fatimaOnboardingNumber,
        whatsappAccountId: WHATSAPP_ACCOUNT_IDS.northwindOnboarding,
        contactId: CONTACT_IDS.fatima,
        status: 'open',
        unreadCount: 1,
        serviceWindowExpiresAt: ahead(now, 23 * HOUR_MS),
        lastMessageAt: ago(now, 5 * MINUTE_MS),
        createdAt: ago(now, 10 * MINUTE_MS),
      },
      {
        id: CONVERSATION_IDS.hectorOptOut,
        whatsappAccountId: WHATSAPP_ACCOUNT_IDS.northwindCare,
        contactId: CONTACT_IDS.hector,
        status: 'resolved',
        assignedUserId: USER_IDS.priya,
        unreadCount: 0,
        serviceWindowExpiresAt: ago(now, 5 * DAY_MS),
        lastMessageAt: ago(now, 6 * DAY_MS),
        createdAt: ago(now, 6 * DAY_MS + HOUR_MS),
      },
    ],

    messages: [
      {
        id: MESSAGE_IDS.fatima1,
        conversationId: CONVERSATION_IDS.fatimaInvoice,
        direction: 'inbound',
        status: 'received',
        contentType: 'text',
        body: "Hi — I still haven't had the July invoice. Could you resend it?",
        providerMessageId: 'wamid.SEED.NW.0001',
        sentAt: ago(now, 3 * HOUR_MS),
      },
      {
        id: MESSAGE_IDS.fatima2,
        conversationId: CONVERSATION_IDS.fatimaInvoice,
        direction: 'outbound',
        status: 'read',
        contentType: 'text',
        body: 'Hello Fatima, of course — let me pull that up for you.',
        senderUserId: USER_IDS.amina,
        providerMessageId: 'wamid.SEED.NW.0002',
        sentAt: ago(now, 175 * MINUTE_MS),
        deliveredAt: ago(now, 174 * MINUTE_MS),
        readAt: ago(now, 172 * MINUTE_MS),
      },
      {
        id: MESSAGE_IDS.fatima3,
        conversationId: CONVERSATION_IDS.fatimaInvoice,
        direction: 'outbound',
        status: 'delivered',
        contentType: 'document',
        body: 'Invoice NW-10021-07.pdf',
        senderUserId: USER_IDS.amina,
        providerMessageId: 'wamid.SEED.NW.0003',
        sentAt: ago(now, 170 * MINUTE_MS),
        deliveredAt: ago(now, 169 * MINUTE_MS),
      },
      {
        id: MESSAGE_IDS.fatima4,
        conversationId: CONVERSATION_IDS.fatimaInvoice,
        direction: 'inbound',
        status: 'received',
        contentType: 'text',
        body: 'Thank you! One more thing — can I change the card on file?',
        providerMessageId: 'wamid.SEED.NW.0004',
        sentAt: ago(now, 20 * MINUTE_MS),
      },
      {
        id: MESSAGE_IDS.fatima5,
        conversationId: CONVERSATION_IDS.fatimaInvoice,
        direction: 'inbound',
        status: 'received',
        contentType: 'text',
        body: 'And could you confirm the new total once it goes through?',
        providerMessageId: 'wamid.SEED.NW.0005',
        sentAt: ago(now, 15 * MINUTE_MS),
      },

      {
        id: MESSAGE_IDS.jonas1,
        conversationId: CONVERSATION_IDS.jonasDoubleCharge,
        direction: 'inbound',
        status: 'received',
        contentType: 'text',
        body: 'We were charged twice for order 4417.',
        providerMessageId: 'wamid.SEED.NW.0011',
        sentAt: ago(now, 5 * HOUR_MS),
      },
      {
        id: MESSAGE_IDS.jonas2,
        conversationId: CONVERSATION_IDS.jonasDoubleCharge,
        direction: 'outbound',
        status: 'read',
        contentType: 'text',
        body: "Thanks Jonas — I've raised this with accounting and will come back to you today.",
        senderUserId: USER_IDS.priya,
        providerMessageId: 'wamid.SEED.NW.0012',
        sentAt: ago(now, 4 * HOUR_MS),
        deliveredAt: ago(now, 4 * HOUR_MS - MINUTE_MS),
        readAt: ago(now, 4 * HOUR_MS - 3 * MINUTE_MS),
      },
      {
        id: MESSAGE_IDS.jonas3,
        conversationId: CONVERSATION_IDS.jonasDoubleCharge,
        direction: 'inbound',
        status: 'received',
        contentType: 'text',
        body: 'Thanks, I will check with accounting.',
        providerMessageId: 'wamid.SEED.NW.0013',
        sentAt: ago(now, 3 * HOUR_MS),
      },

      {
        id: MESSAGE_IDS.mei1,
        conversationId: CONVERSATION_IDS.meiActivation,
        direction: 'inbound',
        status: 'received',
        contentType: 'text',
        body: 'The activation link has expired again.',
        providerMessageId: 'wamid.SEED.NW.0021',
        sentAt: ago(now, 30 * HOUR_MS),
      },
      {
        // A failed send with Meta's own error code for a closed service window.
        // The composer, the retry path and the thread's error rendering all key
        // off this state, and none of them can be looked at without one.
        id: MESSAGE_IDS.mei2,
        conversationId: CONVERSATION_IDS.meiActivation,
        direction: 'outbound',
        status: 'failed',
        contentType: 'text',
        body: "Sorry about that — I'm sending a fresh link now.",
        senderUserId: USER_IDS.liang,
        sentAt: ago(now, 29 * HOUR_MS),
        failedAt: ago(now, 29 * HOUR_MS - 2 * MINUTE_MS),
        errorCode: '131047',
        errorMessage:
          'Message failed to send because more than 24 hours have passed since the customer last replied.',
      },

      {
        id: MESSAGE_IDS.walkIn1,
        conversationId: CONVERSATION_IDS.fatimaOnboardingNumber,
        direction: 'inbound',
        status: 'received',
        contentType: 'text',
        body: 'Hello, is anyone there?',
        providerMessageId: 'wamid.SEED.NW.0031',
        sentAt: ago(now, 5 * MINUTE_MS),
      },

      {
        id: MESSAGE_IDS.hector1,
        conversationId: CONVERSATION_IDS.hectorOptOut,
        direction: 'inbound',
        status: 'received',
        contentType: 'text',
        body: 'Please stop messaging me.',
        providerMessageId: 'wamid.SEED.NW.0041',
        sentAt: ago(now, 6 * DAY_MS + HOUR_MS),
      },
      {
        id: MESSAGE_IDS.hector2,
        conversationId: CONVERSATION_IDS.hectorOptOut,
        direction: 'outbound',
        status: 'read',
        contentType: 'text',
        body: "Understood — I've opted you out. Sorry for the trouble.",
        senderUserId: USER_IDS.priya,
        providerMessageId: 'wamid.SEED.NW.0042',
        sentAt: ago(now, 6 * DAY_MS),
        deliveredAt: ago(now, 6 * DAY_MS - MINUTE_MS),
        readAt: ago(now, 6 * DAY_MS - 2 * MINUTE_MS),
      },
    ],

    attachments: [
      {
        id: MISC_IDS.invoiceAttachment,
        messageId: MESSAGE_IDS.fatima3,
        // Re-hosted rather than Meta's own URL, which expires. The host is a
        // placeholder that resolves to nothing locally; the column's job here is
        // to prove the thread renders an attachment, not to serve a file.
        url: 'https://media.northwind.example/seed/invoice-NW-10021-07.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 48_213,
        filename: 'invoice-NW-10021-07.pdf',
        providerMediaId: '800000000000101',
        createdAt: ago(now, 170 * MINUTE_MS),
      },
    ],

    internalNotes: [
      {
        id: MISC_IDS.noteCardChange,
        conversationId: CONVERSATION_IDS.fatimaInvoice,
        authorUserId: USER_IDS.amina,
        body: 'Card change needs Billing to action — Priya, can you take that half?',
        mentionedUserIds: [USER_IDS.priya],
        createdAt: ago(now, 18 * MINUTE_MS),
      },
      {
        id: MISC_IDS.noteActivation,
        conversationId: CONVERSATION_IDS.meiActivation,
        authorUserId: USER_IDS.liang,
        body: 'Third expired activation link this month. Worth checking the link TTL.',
        mentionedUserIds: [],
        createdAt: ago(now, 28 * HOUR_MS),
      },
    ],

    // One open and one resolved, and they belong to *different* contacts —
    // `tickets_one_active_per_contact` is a partial unique index over
    // (tenant, contact) WHERE status IN ('open','pending'), so a second active
    // ticket for Fatima would make the seed fail on insert.
    tickets: [
      {
        id: TICKET_IDS.fatimaInvoice,
        number: 1,
        subject: 'July invoice and card change',
        status: 'open',
        priority: 'high',
        conversationId: CONVERSATION_IDS.fatimaInvoice,
        contactId: CONTACT_IDS.fatima,
        assignedUserId: USER_IDS.amina,
        assignedTeamId: TEAM_IDS.billing,
        firstResponseAt: ago(now, 175 * MINUTE_MS),
        createdAt: ago(now, 3 * HOUR_MS),
      },
      {
        id: TICKET_IDS.hectorOptOut,
        number: 2,
        subject: 'Opt-out request',
        status: 'resolved',
        priority: 'normal',
        conversationId: CONVERSATION_IDS.hectorOptOut,
        contactId: CONTACT_IDS.hector,
        assignedUserId: USER_IDS.priya,
        firstResponseAt: ago(now, 6 * DAY_MS),
        resolvedAt: ago(now, 6 * DAY_MS - 5 * MINUTE_MS),
        createdAt: ago(now, 6 * DAY_MS + HOUR_MS),
      },
    ],

    ticketEvents: [
      {
        id: MISC_IDS.ticketEventInvoiceCreated,
        ticketId: TICKET_IDS.fatimaInvoice,
        type: 'ticket.created',
        // Null actor: the ticket was opened by the ingestion path, not a person.
        data: { source: 'inbound_message' },
        createdAt: ago(now, 3 * HOUR_MS),
      },
      {
        id: MISC_IDS.ticketEventInvoiceAssigned,
        ticketId: TICKET_IDS.fatimaInvoice,
        type: 'ticket.assigned',
        actorUserId: USER_IDS.priya,
        data: { toUserId: USER_IDS.amina, toTeamId: TEAM_IDS.billing },
        createdAt: ago(now, 176 * MINUTE_MS),
      },
      {
        id: MISC_IDS.ticketEventInvoicePriority,
        ticketId: TICKET_IDS.fatimaInvoice,
        type: 'ticket.priority_changed',
        actorUserId: USER_IDS.priya,
        data: { from: 'normal', to: 'high' },
        createdAt: ago(now, 40 * MINUTE_MS),
      },
      {
        id: MISC_IDS.ticketEventOptOutCreated,
        ticketId: TICKET_IDS.hectorOptOut,
        type: 'ticket.created',
        data: { source: 'inbound_message' },
        createdAt: ago(now, 6 * DAY_MS + HOUR_MS),
      },
      {
        id: MISC_IDS.ticketEventOptOutResolved,
        ticketId: TICKET_IDS.hectorOptOut,
        type: 'ticket.resolved',
        actorUserId: USER_IDS.priya,
        data: { reason: 'contact_opted_out' },
        createdAt: ago(now, 6 * DAY_MS - 5 * MINUTE_MS),
      },
    ],

    nextTicketNumber: 3,

    // Four of the five users occupy a seat (`invited` does not), and five
    // conversations exist. Counted against the subscription's period, never the
    // calendar month.
    usageCounters: [
      { id: MISC_IDS.usageSeats, metric: 'seats', value: 4n },
      { id: MISC_IDS.usageConversations, metric: 'conversations', value: 5n },
    ],

    auditLogs: [
      {
        id: MISC_IDS.auditBillingTeam,
        actorUserId: USER_IDS.omar,
        action: AUDIT_ACTIONS.teamCreated,
        targetType: 'team',
        targetId: TEAM_IDS.billing,
        metadata: { name: 'Billing' },
        createdAt: ago(now, 57 * DAY_MS),
      },
      {
        id: MISC_IDS.auditPriyaRole,
        actorUserId: USER_IDS.omar,
        action: AUDIT_ACTIONS.userRoleChanged,
        targetType: 'user',
        targetId: USER_IDS.priya,
        metadata: { from: 'agent', to: 'supervisor' },
        createdAt: ago(now, 20 * DAY_MS),
      },
      {
        id: MISC_IDS.auditInviteNoor,
        actorUserId: USER_IDS.omar,
        action: AUDIT_ACTIONS.userInvited,
        targetType: 'user',
        targetId: USER_IDS.noor,
        metadata: { role: 'agent' },
        createdAt: ago(now, 2 * DAY_MS),
      },
    ],
  };
}

/**
 * The control tenant. Small on purpose — it is here to be *absent* from
 * Northwind's console, and every row it does not have is one less thing to keep
 * consistent. It still carries an admin and an agent, because the interim role
 * stub resolves a real user per role and a tenant with neither answers 401
 * instead of demonstrating isolation.
 */
function southwind(now: Date): DemoTenant {
  return {
    slug: DEMO_SLUGS.southwind,
    name: 'Southwind Logistics',
    timezone: 'America/New_York',
    locale: 'en-US',
    businessHours: {
      mon: [{ from: '08:00', to: '18:00' }],
      tue: [{ from: '08:00', to: '18:00' }],
      wed: [{ from: '08:00', to: '18:00' }],
      thu: [{ from: '08:00', to: '18:00' }],
      fri: [{ from: '08:00', to: '18:00' }],
    },
    branding: {
      id: MISC_IDS.southwindBranding,
      productName: 'Southwind Freight Desk',
      primaryColor: '#1d4ed8',
      accentColor: '#facc15',
      supportEmail: 'support@southwind.example',
    },
    subscription: { planKey: 'starter', seats: 3, status: 'trialing' },

    users: [
      {
        id: USER_IDS.sofia,
        email: 'sofia@southwind.example',
        name: 'Sofia Marino',
        role: 'admin',
        status: 'active',
        availability: 'available',
        lastSeenAt: ago(now, 25 * MINUTE_MS),
        lastLoginAt: ago(now, 3 * HOUR_MS),
        createdAt: ago(now, 70 * DAY_MS),
      },
      {
        id: USER_IDS.diego,
        email: 'diego@southwind.example',
        name: 'Diego Alvarez',
        role: 'agent',
        status: 'active',
        availability: 'available',
        lastSeenAt: ago(now, 6 * MINUTE_MS),
        lastLoginAt: ago(now, 4 * HOUR_MS),
        createdAt: ago(now, 69 * DAY_MS),
      },
    ],

    teams: [
      {
        id: TEAM_IDS.dispatch,
        name: 'Dispatch',
        description: 'Freight tracking and delivery exceptions.',
        createdAt: ago(now, 69 * DAY_MS),
      },
    ],

    teamMembers: [
      {
        id: '0192f00d-0000-7000-8000-000000000d91',
        teamId: TEAM_IDS.dispatch,
        userId: USER_IDS.diego,
      },
    ],

    businessAccounts: [
      {
        id: BUSINESS_ACCOUNT_IDS.southwind,
        wabaId: '102030405060801',
        name: 'Southwind Logistics Inc',
        verificationStatus: 'verified',
        createdAt: ago(now, 68 * DAY_MS),
      },
    ],

    whatsappAccounts: [
      {
        id: WHATSAPP_ACCOUNT_IDS.southwindDispatch,
        whatsappBusinessAccountId: BUSINESS_ACCOUNT_IDS.southwind,
        phoneNumberId: '550055005500201',
        displayPhoneNumber: '+1 202 555 0199',
        verifiedName: 'Southwind Freight Desk',
        qualityRating: 'green',
        status: 'connected',
        createdAt: ago(now, 68 * DAY_MS),
      },
    ],

    messageTemplates: [
      {
        id: TEMPLATE_IDS.southwindEta,
        whatsappBusinessAccountId: BUSINESS_ACCOUNT_IDS.southwind,
        name: 'shipment_eta',
        language: 'en_US',
        category: 'UTILITY',
        status: 'approved',
        components: welcomeComponents(),
        providerTemplateId: '900000000000191',
        createdAt: ago(now, 60 * DAY_MS),
      },
    ],

    tags: [
      {
        id: TAG_IDS.priorityFreight,
        name: 'Priority freight',
        color: '#facc15',
        createdAt: ago(now, 60 * DAY_MS),
      },
    ],

    customFieldDefs: [],

    contacts: [
      {
        id: CONTACT_IDS.carlos,
        phoneE164: '+12025550143',
        displayName: 'Carlos Mendez',
        locale: 'en',
        lastSeenAt: ago(now, 40 * MINUTE_MS),
        createdAt: ago(now, 30 * DAY_MS),
      },
    ],

    contactTags: [
      {
        id: MISC_IDS.contactTagCarlosFreight,
        contactId: CONTACT_IDS.carlos,
        tagId: TAG_IDS.priorityFreight,
      },
    ],

    conversations: [
      {
        id: CONVERSATION_IDS.carlosFreight,
        whatsappAccountId: WHATSAPP_ACCOUNT_IDS.southwindDispatch,
        contactId: CONTACT_IDS.carlos,
        status: 'open',
        assignedUserId: USER_IDS.diego,
        assignedTeamId: TEAM_IDS.dispatch,
        unreadCount: 0,
        serviceWindowExpiresAt: ahead(now, 20 * HOUR_MS),
        lastMessageAt: ago(now, 35 * MINUTE_MS),
        createdAt: ago(now, 45 * MINUTE_MS),
      },
    ],

    messages: [
      {
        id: MESSAGE_IDS.carlos1,
        conversationId: CONVERSATION_IDS.carlosFreight,
        direction: 'inbound',
        status: 'received',
        contentType: 'text',
        // Deliberately unmistakable: if this line ever appears in Northwind's
        // inbox, tenant isolation is broken and you can see it without a query.
        body: 'SOUTHWIND ONLY — where is container SWL-8891?',
        providerMessageId: 'wamid.SEED.SW.0001',
        sentAt: ago(now, 40 * MINUTE_MS),
      },
      {
        id: MESSAGE_IDS.carlos2,
        conversationId: CONVERSATION_IDS.carlosFreight,
        direction: 'outbound',
        status: 'delivered',
        contentType: 'text',
        body: 'It cleared customs this morning — ETA tomorrow 09:00.',
        senderUserId: USER_IDS.diego,
        providerMessageId: 'wamid.SEED.SW.0002',
        sentAt: ago(now, 35 * MINUTE_MS),
        deliveredAt: ago(now, 35 * MINUTE_MS - 20_000),
      },
    ],

    attachments: [],
    internalNotes: [],
    tickets: [],
    ticketEvents: [],
    nextTicketNumber: null,

    usageCounters: [
      { id: MISC_IDS.usageSeatsSouthwind, metric: 'seats', value: 2n },
      { id: MISC_IDS.usageConversationsSouthwind, metric: 'conversations', value: 1n },
    ],

    auditLogs: [],
  };
}

/**
 * Ids for the one row the seed assembles rather than lists: a `subscriptions`
 * row needs a `plan_id` looked up from the catalogue by key, so it cannot be a
 * literal in the arrays above. Keyed by slug, because the tenant's own id does
 * not exist until provisioning has run.
 */
export const DEMO_SUBSCRIPTION_IDS: Record<string, string> = {
  [DEMO_SLUGS.northwind]: MISC_IDS.northwindSubscription,
  [DEMO_SLUGS.southwind]: MISC_IDS.southwindSubscription,
};

/**
 * The whole dataset, anchored to one clock reading.
 *
 * A function rather than a constant so that every timestamp in one run agrees,
 * and so a test can build it at a fixed instant without waiting for the seed to
 * touch a database.
 */
export function demoDataset(now: Date): readonly DemoTenant[] {
  return [northwind(now), southwind(now)];
}
