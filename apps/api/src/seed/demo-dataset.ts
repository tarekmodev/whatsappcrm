import type { TicketEventType } from '@whatsappcrm/contracts';

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
  /**
   * The stored binaries an attachment points at (TAR-20e). The rows exist; the
   * bytes do not — the seed writes to the database and has no access to
   * `MEDIA_STORAGE_ROOT`, so a download of a seeded object 404s at the storage
   * layer. That is the same trade the placeholder URL made before this table
   * existed, and it keeps the seed a database seed.
   *
   * `storageKey` is omitted as well as the tenant: it is derived from the
   * tenant id, which provisioning assigns, and the seed builds it with
   * `mediaObjectKey` rather than by hand so the two cannot diverge.
   */
  readonly mediaObjects: readonly Omit<
    Prisma.MediaObjectCreateManyInput,
    'tenantId' | 'storageKey'
  >[];
  readonly attachments: readonly Scoped<Prisma.MessageAttachmentCreateManyInput>[];
  readonly internalNotes: readonly Scoped<Prisma.InternalNoteCreateManyInput>[];
  readonly tickets: readonly Scoped<Prisma.TicketCreateManyInput>[];
  /**
   * `type` is narrowed to the contract's enum rather than left as Prisma's
   * `string`. The column is text, so the database accepts any value and a
   * seeded event with a vocabulary of its own would only surface when TAR-73's
   * timeline endpoint validated its response and rejected every seeded ticket.
   * Here it is a compile error instead.
   */
  readonly ticketEvents: readonly (Scoped<Prisma.TicketEventCreateManyInput> & {
    readonly type: TicketEventType;
  })[];
  /**
   * SLA timers (TAR-270, against 0006). `policyId` is omitted as well as the
   * tenant: the policy is the `Default` row `TenantProvisioningService` writes,
   * whose id it generates, so the seed looks it up the same way it looks up a
   * plan by key rather than pinning an id the seed does not own.
   *
   * `due_at` is `started_at + firstResponseMinutes`, computed here rather than
   * left to the writer, because the demo needs one timer that is genuinely past
   * its deadline and one that beat it — and which is which has to be legible in
   * this file rather than emergent from arithmetic somewhere else.
   */
  readonly slaTimers: readonly Omit<Prisma.SlaTimerCreateManyInput, 'tenantId' | 'policyId'>[];
  /**
   * One row per recipient per breached timer, exactly as the sweep would have
   * written them. Seeded so TAR-281 has a supervisor alert to render before
   * TAR-280's sweep runs anywhere.
   *
   * The table is `notifications` since TAR-394 (0009, decision 7); every row here
   * is a `type = 'sla_breach'` one, which the writer sets explicitly.
   */
  readonly slaAlerts: readonly Scoped<Prisma.NotificationCreateManyInput>[];
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
  /**
   * The overdue one (TAR-270). Mei's only outbound message failed on Meta's
   * closed-window error, so the customer was never actually answered — which is
   * the shape of breach worth demonstrating: not an agent ignoring a queue, but
   * a reply that nobody noticed had not landed.
   */
  meiActivation: '0192f008-0000-7000-8000-000000000803',
} as const;

const SLA_TIMER_IDS = {
  fatimaInvoiceFirstResponse: '0192f00e-0000-7000-8000-000000000e01',
  hectorOptOutFirstResponse: '0192f00e-0000-7000-8000-000000000e02',
  meiActivationFirstResponse: '0192f00e-0000-7000-8000-000000000e03',
} as const;

const SLA_ALERT_IDS = {
  /**
   * One row, not two. Priya is the only active supervisor or admin sharing a
   * team with Liang, who holds the breached ticket — Omar is an admin but is in
   * no team, so decision 4's narrowing step excludes him. A seed with an alert
   * for every supervisor would hide the rule it is meant to demonstrate.
   */
  meiActivationToPriya: '0192f00f-0000-7000-8000-000000000f01',
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
  invoiceMediaObject: '0192f00c-0000-7000-8000-000000000c20',
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
  ticketEventActivationCreated: '0192f00c-0000-7000-8000-000000000c66',
  ticketEventActivationBreached: '0192f00c-0000-7000-8000-000000000c67',
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
 * `entitlements` is `PlanEntitlementsSchema` — `{ features, limits }` — and it
 * is that shape because `tenant_entitlements.entitlements` is. TAR-37's billing
 * contract (decision 4) copies a plan's entitlements into that column inside the
 * transaction that activates a subscription, and the destination is guarded by
 * `tenant_entitlements_shape`. A plan seeded in any other shape is an activation
 * that aborts after the tenant has been charged. `plans_entitlements_shape`
 * refuses it here instead.
 *
 * The vocabulary is no longer being invented by this file — it was published in
 * `PlanEntitlementsSchema` before this catalogue was written, and the earlier
 * flat `{ seats, conversationsPerPeriod }` predated it.
 *
 * **Every figure below is a placeholder.** TAR-37's contract open question 6
 * records that the tier numbers are an unmade pricing decision and that they
 * live in seed data precisely so settling them is a data change rather than a
 * migration. `null` means unlimited. Prices are integer minor units against an
 * ISO 4217 code, never a float.
 *
 * `providerProductId` is left unset — the Polar product ids are outstanding
 * (contract open question 4). The checkout route answers `upstream_unavailable`
 * for a plan with no product id rather than calling Polar with a null, and
 * `FakeBillingProvider` ignores the column entirely, so the whole flow is
 * exercisable locally before the credentials land. Filling these in is the
 * one-line seed edit that half of that handoff consists of.
 */
export const DEMO_PLANS: readonly Prisma.PlanCreateManyInput[] = [
  {
    id: PLAN_IDS.starter,
    key: 'starter',
    name: 'Starter',
    priceMinorUnits: 2900,
    currency: 'USD',
    interval: 'month',
    entitlements: {
      features: ['assignment_rules', 'sla_policies'],
      limits: {
        seats: 3,
        conversationsPerPeriod: 1_000,
        whatsappNumbers: 1,
        teams: 2,
        knowledgeDocuments: 10,
      },
    },
    isActive: true,
  },
  {
    id: PLAN_IDS.growth,
    key: 'growth',
    name: 'Growth',
    priceMinorUnits: 7900,
    currency: 'USD',
    interval: 'month',
    entitlements: {
      features: [
        'assignment_rules',
        'sla_policies',
        'workflows',
        'advanced_reporting',
        'api_access',
      ],
      limits: {
        seats: 10,
        conversationsPerPeriod: 10_000,
        whatsappNumbers: 3,
        teams: 10,
        knowledgeDocuments: 100,
      },
    },
    isActive: true,
  },
  {
    id: PLAN_IDS.scale,
    key: 'scale',
    name: 'Scale',
    priceMinorUnits: 19900,
    currency: 'USD',
    interval: 'month',
    entitlements: {
      features: [
        'assignment_rules',
        'sla_policies',
        'workflows',
        'advanced_reporting',
        'api_access',
        'ai_chatbot',
        'custom_branding',
        'custom_domain',
      ],
      limits: {
        seats: 50,
        conversationsPerPeriod: 100_000,
        whatsappNumbers: 10,
        teams: 50,
        knowledgeDocuments: 1_000,
      },
    },
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
        // Priya's reply is the last message on this thread, so this moves with
        // `MESSAGE_IDS.hector2` — `demo-dataset.spec.ts` asserts the two agree.
        lastMessageAt: ago(now, 6 * DAY_MS + 22 * MINUTE_MS),
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
        // 38 minutes after Hector's message, not 60. The gap used to be exactly
        // the default SLA window, which made the ticket's first-response timer a
        // coin toss between `met` and `breached` (the sweep's predicate is
        // `due_at <= now()`, and whether the reply or the sweep lands first at
        // that instant is a race). A seeded row must not be ambiguous about the
        // state it is demonstrating. `tickets.first_response_at` below moves
        // with it.
        sentAt: ago(now, 6 * DAY_MS + 22 * MINUTE_MS),
        deliveredAt: ago(now, 6 * DAY_MS + 21 * MINUTE_MS),
        readAt: ago(now, 6 * DAY_MS + 20 * MINUTE_MS),
      },
    ],

    mediaObjects: [
      {
        id: MISC_IDS.invoiceMediaObject,
        kind: 'document',
        // The agent attached it before sending, which is what `upload` means.
        source: 'upload',
        mimeType: 'application/pdf',
        sizeBytes: 48_213,
        fileName: 'invoice-NW-10021-07.pdf',
        // Not the digest of a real PDF, because there is no PDF: it is the
        // digest of the string above, so the column holds something of the right
        // shape rather than 64 zeroes that read as a real checksum of nothing.
        checksumSha256: '8c2901c8af4c6f7b29ba2013218acecde14972967d00c984a464e8f1064f94c9',
        uploadedByUserId: USER_IDS.amina,
        createdAt: ago(now, 171 * MINUTE_MS),
      },
    ],

    attachments: [
      {
        id: MISC_IDS.invoiceAttachment,
        messageId: MESSAGE_IDS.fatima3,
        mediaObjectId: MISC_IDS.invoiceMediaObject,
        kind: 'document',
        // A path, not an absolute URL: the same row is served through a tenant's
        // platform subdomain and through its custom domain, so the origin is the
        // request's to supply (TAR-20e). The route resolves; the bytes behind it
        // do not, for the reason `mediaObjects` records.
        url: `/api/v1/media/${MISC_IDS.invoiceMediaObject}/content`,
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

    // Two open and one resolved, and they belong to *different* contacts —
    // `tickets_one_active_per_contact` is a partial unique index over
    // (tenant, contact) WHERE status IN ('open','pending'), so a second active
    // ticket for Fatima would make the seed fail on insert.
    //
    // `first_response_user_id` / `resolved_by_user_id` are written here beside
    // the timestamps they attribute (TAR-492). In the running application only
    // `SlaTimerService.stampFirstResponse` and `TicketCommandService` write
    // them, each in the transaction that stamps the matching timestamp (0010,
    // decision 4) — the seed writes rows rather than replaying events, so it
    // has to supply both halves itself, and the one-time backfill migration has
    // long since run by the time `db:seed` inserts these. Left null, every
    // seeded first response and resolution lands in TAR-429's `unattributed`
    // row and the per-agent breakdown demonstrates nothing. Each actor below is
    // the sender of the outbound message, or the actor of the `ticket_events`
    // row, that the timestamp beside it was taken from.
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
        firstRespondedAt: ago(now, 175 * MINUTE_MS),
        // Amina sent `MESSAGE_IDS.fatima2` at that instant. She is also the
        // assignee, but that is this thread's history rather than a rule: the
        // column records who actually replied, and reassignment moves
        // `assigned_user_id` without rewriting it.
        firstResponseUserId: USER_IDS.amina,
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
        // Moves with `MESSAGE_IDS.hector2` above, and for the reason given
        // there: 38 minutes inside the window rather than exactly on it.
        firstRespondedAt: ago(now, 6 * DAY_MS + 22 * MINUTE_MS),
        // Priya sent `MESSAGE_IDS.hector2` and is the actor on
        // `MISC_IDS.ticketEventOptOutResolved`, so both anchors are hers.
        firstResponseUserId: USER_IDS.priya,
        resolvedAt: ago(now, 6 * DAY_MS - 5 * MINUTE_MS),
        resolvedByUserId: USER_IDS.priya,
        createdAt: ago(now, 6 * DAY_MS + HOUR_MS),
      },
      {
        // The overdue ticket (TAR-270). Nobody has replied to Mei in 30 hours —
        // Liang's answer failed on Meta's closed-window error and was never
        // retried — so `first_response_at` is null and its timer breached 29
        // hours ago. This is what TAR-281's queue badge and supervisor alert
        // render before TAR-280's sweep runs anywhere.
        id: TICKET_IDS.meiActivation,
        number: 3,
        subject: 'Activation link keeps expiring',
        status: 'open',
        priority: 'high',
        conversationId: CONVERSATION_IDS.meiActivation,
        contactId: CONTACT_IDS.mei,
        // Held by an agent who is in a team, which is what gives decision 4's
        // narrowing step something to narrow to.
        assignedUserId: USER_IDS.liang,
        assignedTeamId: TEAM_IDS.onboarding,
        createdAt: ago(now, 30 * HOUR_MS),
      },
    ],

    ticketEvents: [
      {
        id: MISC_IDS.ticketEventInvoiceCreated,
        ticketId: TICKET_IDS.fatimaInvoice,
        type: 'created',
        // Null actor: the ticket was opened by the ingestion path, not a person.
        // `cause` matches what TAR-75's linker writes for the same event, so a
        // seeded timeline and a real one read identically.
        data: { conversationId: CONVERSATION_IDS.fatimaInvoice, cause: 'inbound_message' },
        createdAt: ago(now, 3 * HOUR_MS),
      },
      {
        id: MISC_IDS.ticketEventInvoiceAssigned,
        ticketId: TICKET_IDS.fatimaInvoice,
        type: 'assigned',
        actorUserId: USER_IDS.priya,
        data: { toUserId: USER_IDS.amina, toTeamId: TEAM_IDS.billing },
        createdAt: ago(now, 176 * MINUTE_MS),
      },
      {
        id: MISC_IDS.ticketEventInvoicePriority,
        ticketId: TICKET_IDS.fatimaInvoice,
        type: 'priority_changed',
        actorUserId: USER_IDS.priya,
        data: { from: 'normal', to: 'high' },
        createdAt: ago(now, 40 * MINUTE_MS),
      },
      {
        id: MISC_IDS.ticketEventOptOutCreated,
        ticketId: TICKET_IDS.hectorOptOut,
        type: 'created',
        data: { conversationId: CONVERSATION_IDS.hectorOptOut, cause: 'inbound_message' },
        createdAt: ago(now, 6 * DAY_MS + HOUR_MS),
      },
      {
        id: MISC_IDS.ticketEventOptOutResolved,
        ticketId: TICKET_IDS.hectorOptOut,
        // A resolution is a status change, not an event type of its own — the
        // contract has no `resolved`, and `tickets.status` is where the outcome
        // lives. The `from`/`to` shape is the linker's.
        type: 'status_changed',
        actorUserId: USER_IDS.priya,
        data: { from: 'open', to: 'resolved', reason: 'contact_opted_out' },
        createdAt: ago(now, 6 * DAY_MS - 5 * MINUTE_MS),
      },
      {
        id: MISC_IDS.ticketEventActivationCreated,
        ticketId: TICKET_IDS.meiActivation,
        type: 'created',
        data: { conversationId: CONVERSATION_IDS.meiActivation, cause: 'inbound_message' },
        createdAt: ago(now, 30 * HOUR_MS),
      },
      {
        // Null actor: the sweep is not a person. Written in the same transaction
        // as the timer's flip to `breached`, which is what bounds it to one row
        // on an append-only log that cannot carry a unique constraint (0006,
        // decision 3). Its `createdAt` is therefore the timer's `breached_at`.
        id: MISC_IDS.ticketEventActivationBreached,
        ticketId: TICKET_IDS.meiActivation,
        type: 'sla_breached',
        data: { kind: 'first_response' },
        createdAt: ago(now, 29 * HOUR_MS - 20_000),
      },
    ],

    // One timer per ticket, all `first_response`: the seeded policy leaves
    // `resolutionMinutes` null, so no resolution timer exists at v1. `dueAt` is
    // always `startedAt` + the tenant's 60-minute window; the state is what the
    // reply, or its absence, made of it.
    slaTimers: [
      {
        // Answered with five minutes to spare.
        id: SLA_TIMER_IDS.fatimaInvoiceFirstResponse,
        ticketId: TICKET_IDS.fatimaInvoice,
        kind: 'first_response',
        state: 'met',
        startedAt: ago(now, 3 * HOUR_MS),
        dueAt: ago(now, 2 * HOUR_MS),
        // `stoppedAt`, not `breachedAt` — the reply is what stopped it, and it
        // equals `tickets.first_response_at` by construction.
        stoppedAt: ago(now, 175 * MINUTE_MS),
      },
      {
        // Answered 38 minutes into the hour, on a ticket since resolved. A
        // resolved ticket does not cancel a timer that was already met.
        id: SLA_TIMER_IDS.hectorOptOutFirstResponse,
        ticketId: TICKET_IDS.hectorOptOut,
        kind: 'first_response',
        state: 'met',
        startedAt: ago(now, 6 * DAY_MS + HOUR_MS),
        dueAt: ago(now, 6 * DAY_MS),
        stoppedAt: ago(now, 6 * DAY_MS + 22 * MINUTE_MS),
      },
      {
        // The breach. `breachedAt` is twenty seconds past `dueAt` rather than
        // equal to it, because detection is a 30-second sweep and not an
        // interrupt — the lag is a property of the design (0006, decision 1) and
        // a seed that hides it would make the real thing look wrong.
        //
        // `stoppedAt` stays null: `breached` is terminal, and if Liang answers
        // tomorrow the ticket stamps `first_response_at` while this row keeps
        // saying the deadline was missed.
        id: SLA_TIMER_IDS.meiActivationFirstResponse,
        ticketId: TICKET_IDS.meiActivation,
        kind: 'first_response',
        state: 'breached',
        startedAt: ago(now, 30 * HOUR_MS),
        dueAt: ago(now, 29 * HOUR_MS),
        breachedAt: ago(now, 29 * HOUR_MS - 20_000),
      },
    ],

    slaAlerts: [
      {
        id: SLA_ALERT_IDS.meiActivationToPriya,
        slaTimerId: SLA_TIMER_IDS.meiActivationFirstResponse,
        ticketId: TICKET_IDS.meiActivation,
        recipientUserId: USER_IDS.priya,
        kind: 'first_response',
        // Copied from the timer at write time rather than joined at read time:
        // editing the policy later must not rewrite what Priya was told she
        // missed.
        dueAt: ago(now, 29 * HOUR_MS),
        createdAt: ago(now, 29 * HOUR_MS - 20_000),
        // Unacknowledged, so it appears in the supervisor's default view —
        // `GET /api/v1/sla-alerts` defaults `unacknowledgedOnly` to true.
      },
    ],

    nextTicketNumber: 4,

    // Four of the five users occupy a seat (`invited` does not), and five
    // conversations exist. Counted against the subscription's period, never the
    // calendar month.
    usageCounters: [
      { id: MISC_IDS.usageSeats, metric: 'seats', value: 4n },
      { id: MISC_IDS.usageConversations, metric: 'conversations', value: 5n },
    ],

    // Every row here is a tenant admin acting, so all three carry
    // `actorType: 'user'` explicitly (TAR-166). The column has a database
    // default of `unattributed`, which belongs to history the application never
    // recorded — not to demo history it is reproducing on purpose.
    auditLogs: [
      {
        id: MISC_IDS.auditBillingTeam,
        actorType: 'user',
        actorUserId: USER_IDS.omar,
        action: AUDIT_ACTIONS.teamCreated,
        targetType: 'team',
        targetId: TEAM_IDS.billing,
        metadata: { name: 'Billing' },
        createdAt: ago(now, 57 * DAY_MS),
      },
      {
        id: MISC_IDS.auditPriyaRole,
        actorType: 'user',
        actorUserId: USER_IDS.omar,
        action: AUDIT_ACTIONS.userRoleChanged,
        targetType: 'user',
        targetId: USER_IDS.priya,
        metadata: { from: 'agent', to: 'supervisor' },
        createdAt: ago(now, 20 * DAY_MS),
      },
      {
        id: MISC_IDS.auditInviteNoor,
        actorType: 'user',
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

    mediaObjects: [],
    attachments: [],
    internalNotes: [],
    tickets: [],
    ticketEvents: [],
    // No tickets, so no timers and no alerts — but Southwind still gets the
    // `Default` SLA policy, because `TenantProvisioningService` writes one for
    // every tenant it creates. That asymmetry is the point: an SLA alert
    // appearing in Southwind's console would be a tenant-isolation defect, and
    // an empty supervisor view here is what "none of Northwind's" looks like.
    slaTimers: [],
    slaAlerts: [],
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
