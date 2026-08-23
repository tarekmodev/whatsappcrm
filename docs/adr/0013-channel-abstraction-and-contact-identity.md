# ADR 0013 — Channel abstraction and contact identity

- **Status**: Accepted
- **Date**: 2026-08-23
- **Issue**: TAR-818 (Channel abstraction foundation), under TAR-808 (Omnichannel expansion)
- **Author**: Architect
- **Relates to**: ADR 0002 (guard pipeline slot 6), `docs/architecture/0009-tenant-lifecycle-and-self-signup.md`
  (decision 6, and TAR-403's recorded divergence from it)
- **Consumed by**: TAR-819 (this schema), TAR-820, TAR-821, TAR-822, TAR-823

> Landed in the repository by TAR-819, per the Architect's instruction on TAR-818:
> the ADR was posted as a comment there because a discovery issue has no PR, and
> the first PR in the chain is where it belongs.
>
> **The body is the Architect's text**, as corrected by their ruling of
> 2026-08-23: Context, Decision 4's write-site list and the Migration strategy
> section were rewritten in place, so each reads correctly on its own, and the
> amendments are the record of why. Amendment 1 is TAR-819's four implementation
> findings, all accepted, with the Architect's rulings inline. Amendment 2 is the
> Architect's, from the code review of PR #250.
>
> Every deviation from what is written here should come back to the Architect
> rather than be resolved locally. That is TAR-819's own acceptance criterion and
> it applies to all five downstream issues.

## Context and Problem

WhatsApp is not _a_ channel in this codebase; it is the only shape a conversation
can have. `conversations.whatsapp_account_id` is `NOT NULL` and sits in the
thread's natural key `@@unique([tenantId, whatsappAccountId, contactId])` — the
only index on the table that carries it. 81 references across 23 non-test files.

It is the column that decides **thread ownership**, not the column the inbox
**reads through**: the three hot inbox indexes key on
`(tenant_id, …, last_message_at DESC, id DESC)` and never mention it. An earlier
draft of this ADR said the column "leads all three hot inbox indexes"; that was
wrong, and Amendment 1.1 records how it was checked.

Two constraints decide this ADR:

1. **Thread ownership.** `whatsapp_account_id` is what makes a thread a WhatsApp
   thread: it is in the natural key, it is the parent every conversation
   cascades from, and `WhatsAppAccountResolver` routes sends and webhooks
   through it. The assignment-scope inbox indexes do not carry it — the inbox
   lists a tenant's threads, not an account's. TAR-808 AC1 ("WhatsApp itself
   runs through the new abstraction, no behavior regression") is exactly this
   column.
2. **Contact identity.** `contacts` is `@@unique([tenantId, phone_e164])`,
   `NOT NULL`. Instagram has no phone number — identity is a page-scoped IGSID.
   **This, not the account model, is the hard part**, and it is what a "second
   WhatsApp-shaped system beside the first" would get permanently wrong.

One seam is already channel-ready and should be left alone: `webhook_events`
carries `provider` and dedupes on `(provider, provider_event_id)`. A second
channel's webhooks reuse the existing table, sweeper, replay tooling and admin
console with **no migration**.

## Decision 1 — `channels` as a supertype, class-table inheritance

A `channels` row per connected channel holds what every channel has.
Provider-specific columns stay in their own table, joined on a **shared primary
key**.

```prisma
enum ChannelKind { whatsapp instagram messenger }

/// `connected | disconnected | error` — the same three values
/// `WhatsappAccountStatus` already carries, moved up. Sendability stays
/// per-provider (`whatsapp_accounts.registration_status`) for the reason
/// that enum already documents: the two cannot be one column.
enum ChannelStatus { connected disconnected error }

model Channel {
  id          String        @id @default(uuid(7)) @db.Uuid
  tenantId    String        @map("tenant_id") @db.Uuid
  kind        ChannelKind
  status      ChannelStatus @default(disconnected)
  /// What an operator sees in a channel list. Display only.
  displayName String        @map("display_name")
  /// The provider's own id for this endpoint, and the webhook routing key:
  /// `phone_number_id` for WhatsApp, the IG professional account id for
  /// Instagram, the Page id for Messenger.
  ///
  /// Unique across tenants **within a kind**, for the reason
  /// `whatsapp_accounts.phone_number_id` is unique globally today: one Meta app
  /// serves every tenant, so nothing on an inbound delivery names a tenant
  /// except the endpoint it arrived on. Scoped by `kind` rather than globally
  /// because a Page id and an IG account id are different namespaces.
  routingKey  String        @map("routing_key")
  connectedAt DateTime?     @map("connected_at") @db.Timestamptz(3)
  createdAt   DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime      @updatedAt @map("updated_at") @db.Timestamptz(3)

  tenant        Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  whatsapp      WhatsappAccount?
  instagram     InstagramAccount?
  conversations Conversation[]

  @@unique([kind, routingKey])
  @@unique([tenantId, id])
  @@index([tenantId, kind])
  @@map("channels")
}
```

`whatsapp_accounts` keeps only what is genuinely WhatsApp's — the WABA FK,
`display_phone_number`, `verified_name`, `quality_rating`,
`registration_status`, `registration_pin_encrypted`,
`registration_failure_reason`, `registered_at`, `registration_attempted_at` —
and its `id` becomes both PK and FK to `channels.id`. `phone_number_id` **moves**
to `channels.routing_key`; do not keep a copy, two sources of truth for a routing
key is how a message lands in the wrong tenant's inbox.

**The property that makes phase 2 safe: the channel row takes the
`whatsapp_accounts.id` value that already exists.** So
`conversations.whatsapp_account_id → channel_id` is an identity copy, not a
remap. The migration is a rename with a new parent table above it, and every
existing id in logs, audit rows and tests still resolves.

_Rejected: one polymorphic `channel_accounts` table with a `kind` discriminator
and a JSONB `provider_config`._ Fewer tables and it looks cheaper. But this
schema's entire style is explicit columns with CHECK constraints and indexes
justified at the line; JSONB appears only where the shape is genuinely the
provider's (`message_templates.components`). Channel account fields are ours to
constrain, and putting an encrypted credential and a registration state machine
into a JSON bag discards every constraint that currently makes those correct —
including the AAD binding on `registration_pin_encrypted`.

_Rejected: `conversations.channel_kind` + a nullable FK per kind._ No supertype
row means no single thing to name in `conversations`, no single place for
`status`, and one more nullable FK per wave-2 channel.

## Decision 2 — `contact_identities`, and `contacts.phone_e164` becomes nullable

```prisma
model ContactIdentity {
  id          String      @id @default(uuid(7)) @db.Uuid
  tenantId    String      @map("tenant_id") @db.Uuid
  contactId   String      @map("contact_id") @db.Uuid
  kind        ChannelKind
  /// The provider's id for this person on this kind of channel: E.164 for
  /// WhatsApp, the IGSID for Instagram, the PSID for Messenger.
  externalId  String      @map("external_id")
  /// The profile name the provider attaches to an inbound batch, per channel —
  /// the same person is "Tarek" on WhatsApp and an @handle on Instagram, and
  /// `contacts.display_name` can only hold one of them.
  displayName String?     @map("display_name")
  lastSeenAt  DateTime?   @map("last_seen_at") @db.Timestamptz(3)
  createdAt   DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  contact Contact @relation(fields: [tenantId, contactId], references: [tenantId, id], onDelete: Cascade)

  /// The inbound resolution key — one lookup per delivery, replacing
  /// `(tenant_id, phone_e164)`.
  @@unique([tenantId, kind, externalId])
  @@unique([tenantId, id])
  @@index([tenantId, contactId])
  @@map("contact_identities")
}
```

Scoped by `(tenant, kind)` rather than by channel row, deliberately. A phone
number is the same person across every WhatsApp number a tenant connects, so
WhatsApp keeps today's cross-number unification. An IGSID is already scoped to
the IG account that received it, so two connected IG accounts yield two distinct
`external_id` values and cannot collide — the same key serves both without a
per-channel column nobody needs.

`contacts.phone_e164` becomes nullable and stops being the identity key; it stays
as the phone number **when one is known**, which is what contact search, export
and the CRM view read.

_Rejected: separate Contact rows per channel with `phone_e164` widened to a
generic `external_id`._ Cheaper migration, but "the same customer on WhatsApp and
Instagram" becomes unrepresentable, and merging later is a data-quality project
rather than a feature.

## Decision 3 — three ports, not one adapter interface

Channels differ along three independent axes. One fat `ChannelAdapter` interface
would force every channel to implement methods it has no concept for
(`sendTemplate` on Instagram) and to answer questions it does not own.

```ts
// ---- inbound: provider payload -> normalized envelope --------------------

interface ChannelIdentityRef {
  readonly kind: ChannelKind;
  readonly externalId: string;
  readonly displayName: string | null;
}

/** Where the bytes are, per provider. WhatsApp hands back a media id that must
 *  be resolved against the Graph API; Instagram hands back a short-lived CDN
 *  URL. `whatsapp-media.service.ts` only knows the first. */
type InboundMediaRef =
  | {
      readonly via: 'provider_id';
      readonly providerMediaId: string;
      readonly mimeType: string | null;
    }
  | { readonly via: 'url'; readonly url: string; readonly mimeType: string | null };

interface NormalizedInboundMessage {
  readonly providerMessageId: string;
  readonly from: ChannelIdentityRef;
  readonly sentAt: Date;
  readonly contentType: MessageContentType;
  readonly body: string | null;
  readonly media: InboundMediaRef | null;
  /** Whether this delivery opens the 24h window. False for a status receipt —
   *  the rule `ConversationOpening` already documents, made explicit so the
   *  writer stops inferring it from the payload shape. */
  readonly opensServiceWindow: boolean;
}

interface NormalizedStatusUpdate {
  readonly providerMessageId: string;
  readonly recipient: ChannelIdentityRef;
  readonly status: MessageStatus;
  readonly occurredAt: Date;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

interface InboundEnvelope {
  readonly kind: ChannelKind;
  /** Matches `channels.routing_key`. */
  readonly routingKey: string;
  readonly messages: readonly NormalizedInboundMessage[];
  readonly statuses: readonly NormalizedStatusUpdate[];
}

interface InboundChannelAdapter {
  readonly kind: ChannelKind;
  /** The HMAC over the raw body. Stays per-adapter because the header name and
   *  the secret are per-provider even when the app is shared. */
  verifySignature(rawBody: Buffer, headers: IncomingHttpHeaders): boolean;
  verifyHandshake(candidateToken: string, challenge: string): string;
  /** One envelope per routing key in the payload. Meta batches across
   *  endpoints; the writer must not have to know that. */
  parse(payload: unknown): readonly InboundEnvelope[];
}

// ---- outbound: normalized command -> provider send ----------------------

interface OutboundChannelAdapter {
  readonly kind: ChannelKind;
  sendText(cmd: SendTextCommand): Promise<SentMessage>;
  sendMedia(cmd: SendMediaCommand): Promise<SentMessage>;
}

/** WhatsApp only. Deliberately a separate optional port rather than a method
 *  on the interface above — see Decision 6. */
interface TemplateCapableAdapter {
  sendTemplate(cmd: SendTemplateCommand): Promise<SentMessage>;
}

// ---- send policy: may this go out at all? -------------------------------

type SendDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: SendRefusalReason };

interface SendPolicy {
  readonly kind: ChannelKind;
  evaluate(conversation: ServiceWindow, intent: OutboundIntent, now: Date): SendDecision;
}
```

All three are addressed by `channelId` (our id), never by a provider id — the
invariant `WhatsAppSenderService` already holds and the reason
`WhatsAppCredentialResolver` exists. Adapters are registered in a
`Map<ChannelKind, …>` keyed by their own `kind`; no `switch` on kind outside that
registry.

`WhatsAppAccountResolver` generalizes to `ChannelResolver.resolve(kind, routingKey)`
— still `SystemPrisma`, still uncached, still one class so the cross-tenant read
stays visible in a grep for `SYSTEM_PRISMA`.

**Inbound flow after the refactor:**

```mermaid
flowchart LR
  A[POST /api/webhooks/:kind] --> B[InboundChannelAdapter.verifySignature]
  B --> C[webhook_events insert<br/>provider + provider_event_id]
  C --> D[200 to Meta]
  C --> E[queue]
  E --> F[adapter.parse -> InboundEnvelope]
  F --> G[ChannelResolver.resolve<br/>kind + routingKey]
  G --> H[InboundWriter<br/>contact_identities -> conversations -> messages]
  H --> I[existing assignment / SLA / workflow / realtime]
```

Everything from `H` rightward is unchanged code. That is the point of the
abstraction, and it is what TAR-822's "no Instagram-specific parallel inbox
logic" criterion is measured against.

**Routes:** one controller path per kind (`/api/webhooks/whatsapp`,
`/api/webhooks/instagram`, `/api/webhooks/messenger`), all `VERSION_NEUTRAL` and
`@PlatformRoute()`. Not one polymorphic route: each URL is registered separately
in Meta's dashboard, verify tokens are per-URL, and a shared path would make one
channel's misconfiguration another channel's outage.

## Decision 4 — entitlement gating (TAR-808 AC3, TAR-821's contract)

Add three booleans to `PLAN_FEATURES` in `packages/contracts/src/billing.ts`:

```ts
'channel_whatsapp', 'channel_instagram', 'channel_messenger',
```

**Plan default vs tenant override needs no new table.** `tenant_entitlements` is
already the per-tenant materialization of a plan — TAR-403 diverged from ADR 0009
decision 6 for exactly this reason and recorded it on the model.
`plans.entitlements` holds the plan-level default;
`tenant_entitlements.entitlements.features` holds the tenant's effective set. An
override _is_ writing a different array into the tenant row. TAR-821 should not
invent a third location.

**Do not use `PlanFeaturesService.includes()` for this.** It fails **open** by
design and documents why — an unstated feature is granted, because failing closed
would refuse every tenant on the platform today. That is correct for
`ai_chatbot`; it is precisely wrong for AC3, which requires a refusal.
`FeatureGuard` (ADR 0002 pipeline slot 6, TAR-37) still does not exist.

TAR-821 adds a separate, **fail-closed** reader:

```ts
@Injectable()
class ChannelEntitlementService {
  /** Throws `ChannelNotEntitledError` when the tenant's effective entitlements
   *  do not name `channel_<kind>`. Absent means refused — the opposite default
   *  to `PlanFeaturesService`, and the difference is the whole reason this is a
   *  second class rather than a flag on the first. */
  assertConnectable(kind: ChannelKind): Promise<void>;
  listConnectable(): Promise<readonly ChannelKind[]>;
}
```

**Do not read the tenant's effective entitlements through
`BillingReaderService.toPlan`.** That path substitutes
`{ features: [], limits: EMPTY_LIMITS }` for a row that fails
`PlanEntitlementsSchema`, which is correct where it lives — a hand-edited
catalogue row must not take the pricing page down. Behind a fail-closed gate the
same substitution refuses every channel to every tenant on that plan, silently.
The gate must distinguish **parsed and absent** (refuse the tenant, that is the
feature) from **did not parse** (a fault: log, alert, and do not answer the
question). Two different failures reaching the same `[]` is how a catalogue typo
becomes a platform-wide outage.

Failing closed is only safe because **every existing write site is backfilled in
the same migration**. There are five, and TAR-819 must cover all of them or
WhatsApp connect breaks — on day one for three of them, and on the next
subscription event for the two catalogue rows:

- existing `tenant_entitlements` rows — backfill `channel_whatsapp` into `features`
- the column default on `TenantEntitlements.entitlements`
- **existing `plans.entitlements -> 'features'` rows — backfilled in the
  migration, not in the seed.** `SubscriptionSyncService.copyEntitlements`
  replaces a tenant's array wholesale from its plan on every subscription event,
  so a stale catalogue row silently reverts the first bullet. `plans` carries no
  RLS policy, so this one needs no `NO FORCE` toggle.
  `20260822130000_billing_polar_provider_ids` is the precedent and argues the
  same case.
- `TenantProvisioningService` (`apps/api/src/tenancy/tenant-provisioning.service.ts:568`)
  and `UNCAPPED_ENTITLEMENTS` in `apps/api/src/entitlements/plan-limits.service.ts:46`
  — both spread `[...PLAN_FEATURES]` and move on their own
- the three `demo-dataset.ts` plan rows — the seed's copy of the catalogue, which
  keeps a freshly seeded environment consistent with the bullet above. It is not
  a substitute for it: `db:seed` is in neither `preDeployCommand`.

**The general rule this is an instance of.** A fail-closed reader converts every
gap in its input into a refusal. Adding one is therefore not a local change — it
makes every writer of that input load-bearing, including writers nobody thought
of as entitlement code. Before TAR-821's gate ships, the question to ask of each
write site is not "does it set the flag" but "can it ever produce an array
without the flag", and `copyEntitlements` answers yes for any row it reads from.

**Refusal shape.** A named error code, not a generic 403: `channel_not_entitled`,
HTTP 403, body naming the `channelKind` refused and the tenant's plan key. AC3's
words are "a clear reason, not a silent failure" — a bare `forbidden` fails that
criterion. Register it in `packages/contracts/src/error-codes.ts` alongside the
existing codes.

**Where the gate is called:** the connect path for every kind, before any Graph
API call. Checking it at send time as well is not required by AC3 and would put
an entitlement read in the hot path.

**`plan_limits.whatsappNumbers` is declared, seeded, and enforced nowhere** —
grep finds only defaults and seed data, no call site. Decision: **leave it
alone**. Do not generalize it to a `channelsPerKind` map in this wave;
generalizing an unenforced limit produces a second unenforced limit with more
shape. When someone enforces it, the channel-connect path is where it attaches.

## Decision 5 — webhook secrets and app identity

Config today: `META_APP_ID`, `META_EMBEDDED_SIGNUP_CONFIG_ID`,
`WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_API_VERSION`
(default `v23.0`).

`WHATSAPP_APP_SECRET` is the **Meta app's** secret, not WhatsApp's. If Instagram
and Messenger run under the same Meta app, one secret verifies all three
signatures and `isValidWhatsAppSignature` generalizes unchanged. Verify tokens
are per-webhook-URL and each kind needs its own.

Decision: introduce `META_APP_SECRET` as the canonical name, keep
`WHATSAPP_APP_SECRET` as a deprecated alias so no environment breaks, and add
`INSTAGRAM_WEBHOOK_VERIFY_TOKEN` / `MESSENGER_WEBHOOK_VERIFY_TOKEN`. Keep the
existing "configured or refuse" posture — `WebhookChannelNotConfiguredError`
already models a channel that was never given a secret, and it should stay
per-kind so an unconfigured Instagram cannot take WhatsApp down.

## Decision 6 — what deliberately does NOT generalize

**Message templates.** `message_templates` is WABA-scoped and Meta-approved.
Instagram has no template concept; it has the 24-hour window plus a message tag
for limited post-window sends. Generalizing `MessageTemplate` into a
channel-neutral entity would model a fiction, and it is why `sendTemplate` sits
on a separate `TemplateCapableAdapter` port above.

**`conversations.service_window_expires_at` does generalize** — all three Meta
channels have a 24-hour window opened by the customer. What differs is the
_escape hatch_ out of it, which is why `SendPolicy` is its own port: WhatsApp's
is an approved template, Instagram's and Messenger's is a message tag.
`isServiceWindowOpen` stays exactly as it is; only the "what may I send instead"
branch is per-kind.

**`media_objects`** stays as-is. Only the inbound _fetch_ differs
(`InboundMediaRef` above); storage, checksum, dedup and retention are
channel-agnostic already.

## Migration strategy — the handoff to TAR-819 and TAR-820

**Two migrations, not three.** The original draft called for expand / migrate /
contract, "each independently deployable". Only the expand step is: three of
migrate's four changes refuse a write the running application still makes, so a
standalone migrate release is an outage rather than a migration. Migrate and
contract are therefore one migration, and it ships in the same release as
TAR-820's writers. Amendment 1.2 has the per-change reasoning.

### 0. The rule every backfill in this ADR obeys

**A migration that reads a `FORCE ROW LEVEL SECURITY` table must toggle
`NO FORCE` on the tables it reads, not only the tables it writes.** The migration
role is not exempt from `FORCE`, and no migration sets `app.tenant_id`, so an
untoggled source table returns zero rows and the backfill reports success having
inserted nothing — the worst failure available, because it is silent.
`20260815120000_branding_and_custom_domains:135` states the rule and
`20260816150100_reporting_attribution_backfill` follows it for two read-only
tables.

This is written as a rule here because the local and CI databases both run
migrations as the initdb superuser, so the toggles are inert there and no test
can catch a missing one. See Amendment 2.

### 1. Expand — TAR-819, shipped additive

Create `channels` and `contact_identities`. Insert one `channels` row per
`whatsapp_accounts` row **reusing that row's `id`**, `kind = 'whatsapp'`,
`routing_key = phone_number_id`,
`display_name = COALESCE(verified_name, display_phone_number)`, `status` copied.
Insert one `contact_identities` row per contact (`kind = 'whatsapp'`,
`external_id = phone_e164`). Add `conversations.channel_id` nullable and copy
from `whatsapp_account_id`. Create the successor unique
`(tenant_id, channel_id, contact_id)` **now**, while it is empty and cold, so
TAR-820 flips a built-and-analysed index rather than building one under a live
inbox. `contacts.phone_e164` `DROP NOT NULL` — additive, and moved here from the
old step 2, since relaxing a constraint refuses no write. Add
`ChannelKind`/`ChannelStatus` to `packages/contracts`. Backfill the five
entitlement write sites from Decision 4. **No application code reads the new
columns** — that is this migration's acceptance criterion.

Per rule 0, the toggle list is five tables: `channels`, `contact_identities` and
`conversations` (written) plus `whatsapp_accounts` and `contacts` (read). Every
backfill closes with a count assertion against its source, so an empty result
raises instead of committing.

Requires a manual `VACUUM (ANALYZE) "public"."conversations"` after applying —
see Amendment 1.3.

### 2. Migrate + contract — TAR-820, same release as its writers

Every change here is gated on TAR-820's code being deployed in the same release:

- **Re-run the expand migration's backfill block, first, before anything
  tightens.** Expand's backfills are a point-in-time snapshot; rows written
  between the two releases are not tracked forward, and no trigger keeps them in
  step (a trigger would be a second writer for TAR-820 to remove, for a table
  nothing reads). This is three backfills, and the order is load-bearing:
  `channels` rows for numbers connected during the window, then
  `contact_identities` rows for contacts created during it, then
  `conversations.channel_id` for threads opened during it. The block is
  idempotent by construction — `ON CONFLICT DO NOTHING` on both inserts,
  `WHERE channel_id IS NULL` on the update — so re-running it is safe and is the
  only correct way to do this. Re-run the block **as corrected**, carrying rule
  0's five-table toggle and the count assertions; a re-run that reads through
  `FORCE` finds nothing and tightens over a gap.
- `conversations.channel_id` `NOT NULL`.
- `whatsapp_accounts.id` becomes an FK to `channels.id`. **Implementation
  constraint:** the connect path must write the `channels` row and the
  `whatsapp_accounts` row in one transaction, channel first. Today it writes the
  account row alone, after the Graph API calls have already succeeded — adding
  the FK without that change fails the connect at its last step, with Meta-side
  state already committed.
- Drop `conversations.whatsapp_account_id`, drop
  `whatsapp_accounts.phone_number_id`, drop the old unique
  `(tenant_id, whatsapp_account_id, contact_id)` and the old unique on
  `contacts`. TAR-820's "no dual code path left behind" is what makes this safe.

**No index rebuild.** `whatsapp_account_id` is in exactly one index on
`conversations` — the natural-key unique — and the migration adds a sibling to
that one rather than rebuilding anything. The three inbox indexes are untouched
by this work in either release (Amendment 1.1).

RLS: both new tables are tenant-scoped and take the standard `tenant_isolation`
policy plus a `tenant-scope.extension.ts` classification. Neither is
`system-only`. `ChannelResolver` reads `channels` through `SystemPrisma` for the
same documented reason `WhatsAppAccountResolver` does today.

**Index note, still binding:** the three `conversations` inbox indexes carry
measured `EXPLAIN` numbers in their doc comments (3 094 buffers → 6, 39 333
rows-removed-by-filter → 0 on 120 000 conversations). Nothing in TAR-819 or
TAR-820 rebuilds them, but they remain the regression baseline for any work that
does, column order included, and
`conversations_tenant_assigned_user_inbox_idx` keeps its explicit `map` name
because Prisma's generated name exceeds Postgres's 63-character limit.

## Meta credentials — finding, and what still needs the spike

Recorded against TAR-818's fourth acceptance criterion. **Do not assume
WhatsApp's grant carries over — it does not.**

What can be stated from the code and from how Meta's platform is structured:

- One Meta app can host WhatsApp, Instagram and Messenger products
  simultaneously, so **`META_APP_ID` is reusable** and a shared app secret
  verifies all three webhook signatures.
- The **permission grants are separate App Review submissions**. WhatsApp Cloud
  API uses `whatsapp_business_messaging` / `whatsapp_business_management`;
  Instagram messaging and Messenger require their own messaging permissions on
  their own review. Holding one grants nothing about the others.
- **`META_EMBEDDED_SIGNUP_CONFIG_ID` is WhatsApp-specific.** Embedded Signup is a
  WhatsApp onboarding flow; Instagram and Messenger connect through a different
  Facebook Login for Business configuration against a Page. TAR-822's connect
  flow is therefore **not** a parameterization of `embedded-signup.service.ts` —
  plan for a second OAuth configuration, not a reused one.

**Needs verification, and is not invented here:** the exact current permission
names, whether Instagram messaging requires the connected Page to be in a
specific linkage state, and — the one that can reorder the whole plan — **App
Review lead time**. There is no basis for a figure and none is published.

This is why the spike runs in parallel from day 1: nothing in this ADR unblocks
it, and if review is measured in weeks it becomes the real critical path into
TAR-822. TAR-824 owns it.

## Failure Modes and Operations

| Condition                                | Behavior                                                 | Notes                                                                                            |
| ---------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Unknown `routing_key` on inbound         | Event parked with `unknown_routing_key`, replayable      | Generalizes the existing `unknown_phone_number_id` path; `webhook_event_replays` needs no change |
| One adapter's secret unconfigured        | That kind's route refuses; other kinds unaffected        | Requires per-kind config checks — do not collapse to one guard                                   |
| Provider unreachable / throttled         | Retried, per `OutboundMessageDispatcher`'s existing rule | Only Meta-unreachable and Meta-throttling are retried; rejected requests and credentials are not |
| Adapter registry has no entry for a kind | Startup failure, not a runtime 500                       | A channel kind in the DB with no registered adapter is a deploy error                            |
| Tenant not entitled to a channel         | `channel_not_entitled`, 403                              | Connect path only                                                                                |

Monitoring: `webhook_events` parked-count should be reported **per provider**
once a second provider exists, or Instagram failures hide inside WhatsApp's
volume.

## Security and Access

Credentials stay per-channel and encrypted at rest under the existing cipher,
decrypted only in the send path. `channels` holds **no** credential column —
tokens stay on the provider-specific tables, where their AAD binding still means
something. No secret value appears in an API projection, a log line, or an audit
row. Tenant isolation is unchanged and remains RLS's job; the entitlement gate is
a commercial ceiling, not a security boundary, and nothing in Decision 4 should
be read as one.

## Consequences

**Accepted cost:** TAR-820 is a wide, low-glory refactor across 23 files and the
product's hottest indexes. It produces no visible feature. It is where this
issue's schedule risk sits and it is the phase most likely to attract pressure to
be skipped in favour of bolting Instagram on beside WhatsApp. TAR-808 AC1 exists
to stop that, and the id-preserving migration above is what keeps the cost
bounded.

**Gained:** wave-2 channels (Email, Telegram, Voice, X, Live chat) implement
three small ports and touch no inbox, ticket, assignment, SLA or workflow code.
TAR-823 (Messenger) is the first measurement of whether that is true — if
Messenger is not materially smaller than Instagram, the ports are wrong and that
is the signal to come back to the Architect before wave 2 is scoped.

## Open Questions and Risks

1. **App Review lead time.** Unverified, unquantified, and the only unknown that
   can reorder the plan. Resolution: TAR-824, the parallel stage-1 spike.
2. **Pre-production data policy conflicts with AC1's wording.** TAR-819 states
   there is no live tenant data; TAR-808 AC1 speaks of no behavior regression.
   These are compatible — AC1 is about _behavior_, verified by the existing
   WhatsApp suite, not about preserving rows. But it means the migration may be
   rewritten freely if the three-step sequence proves awkward, **provided the
   four entitlement write sites are still backfilled**; failing closed on
   `channel_whatsapp` with an unbackfilled `demo-dataset.ts` breaks every seeded
   environment. Resolution: TAR-819 confirms the data situation before choosing.
3. **Cross-channel contact merge.** `contact_identities` makes "one customer, two
   channels" _representable_. It does not implement merge — no UI, no automatic
   linking, no dedup heuristic. Explicitly out of scope for TAR-808; flagged so
   nobody assumes it arrives with TAR-819.
4. **`MessageContentType` coverage.** Instagram carries story replies, mentions
   and reactions with no WhatsApp equivalent. The enum has not been audited
   against Instagram's full message type list. Resolution: TAR-822 audits it and
   comes back to the Architect if the enum needs values — an enum change is a
   migration, so finding it late is expensive.
5. **`sendTemplate` callers.** `WhatsAppSenderService.sendTemplate` has callers in
   the inbox send path and in workflow actions. Those call sites must become
   kind-aware or the template port leaks back into generic code. Resolution:
   TAR-820 routes them through `SendPolicy`, and flags to the Architect if any
   resists.

Estimates are deliberately absent.

---

## Amendment 1 — TAR-819 implementation findings

**Author**: Database Specialist. **Date**: 2026-08-23.
**Status**: **accepted** by the Architect, 2026-08-23. All four findings stand;
1.1 and 1.2 are corrections to the ADR's own text and are folded into Context and
Migration strategy above, so those sections now read correctly on their own and
this amendment is the record of why they changed. 1.3 and 1.4 are additions the
ADR did not cover. Architect's rulings are inline below, marked **Ruling**.

Four things could not be built as the migration strategy above describes them.
Each is recorded here with what was done instead; nothing in decisions 1–6 is
contradicted.

### 1. `whatsapp_account_id` leads none of the three inbox indexes

The Context section says it "leads all three hot inbox indexes". Checked against
`schema.prisma` and against every `CREATE INDEX` on `conversations` in
`prisma/migrations`, it leads none of them. The three are:

```
conversations_tenant_id_status_last_message_at_id_idx  (tenant_id, status, last_message_at DESC, id DESC)
conversations_tenant_assigned_user_inbox_idx           (tenant_id, assigned_user_id, status, last_message_at DESC, id DESC)
conversations_tenant_assigned_team_inbox_idx           (tenant_id, assigned_team_id, status, last_message_at DESC, id DESC)
```

The column appears in exactly one index on the table: the unique
`(tenant_id, whatsapp_account_id, contact_id)`. **So the "three inbox indexes
rebuilt on `channel_id`" in migrate step 2 is not a change that exists.** The
measured baselines those doc comments carry are not at risk from this work, and
the migration adds a sibling unique index rather than touching them.
`channel-schema.int-spec.ts` asserts all five index definitions verbatim so the
claim stays checked.

This is the safe direction, but it means step 2 is smaller than the ADR costs it
at, and TAR-820 should be re-sized accordingly.

> **Ruling (Architect, 2026-08-23):** confirmed and independently re-checked
> against `schema.prisma` and every `CREATE INDEX` on `conversations` in the
> migration history. The ADR was wrong; Context and Migration strategy are
> corrected above. TAR-820's scope is re-sized: it never owned an index rebuild,
> and its issue now says so.

### 2. Three of migrate step 2's four changes cannot deploy independently

Step 2 is described as independently deployable. Three of its four changes refuse
a write the running application still makes, so shipping it before TAR-820 is an
outage rather than a migration:

- `conversations.channel_id NOT NULL` — the inbound writer sets
  `whatsapp_account_id` alone; the next message from a new contact fails to
  insert.
- `whatsapp_accounts.id` as a foreign key to `channels.id` — connecting a number
  writes `whatsapp_accounts` with no `channels` row, so WhatsApp connect fails on
  its last step, after the Graph API calls have succeeded.
- dropping either old column — every read of both is still live.

**Resolution taken:** TAR-819 ships the expand step only, as
`20260823140000_channel_supertype_and_contact_identities` plus
`20260823140100_channel_entitlement_features`. The remaining changes belong in
one migration that lands in the same release as TAR-820's writers. The fourth
change, `contacts.phone_e164 DROP NOT NULL`, **is** additive and is in the expand
migration, per TAR-819's own acceptance criteria.

A consequence worth naming: `channels`, `contact_identities` and
`conversations.channel_id` are a point-in-time snapshot. Rows written between the
two releases are not tracked forward, so **TAR-820's migration must re-run the
same backfill** before it tightens anything. No trigger was added to keep them in
step: nothing reads the new tables during the window, and a trigger would be a
second writer for TAR-820 to remove.

> **Ruling (Architect, 2026-08-23):** accepted, and the expand-only split is the
> right call — a migration that refuses a live write is not a migration. The
> no-trigger decision is also correct: a trigger buys consistency for a table
> nothing reads, and charges TAR-820 a removal. Two things this makes binding on
> TAR-820, both now written into that issue: its migration re-runs the expand
> backfill block verbatim and first (three backfills, in order), and the connect
> path writes `channels` before `whatsapp_accounts` in one transaction before the
> FK is added.

### 3. `ANALYZE` is not enough after the `conversations` backfill

The expand migration rewrites every `conversations` row. All three inbox indexes
are served by **Index Only Scans**, which stop being index-only until a `VACUUM`
resets the visibility map. Measured on 120 000 conversations, 2 000 of them the
principal's, one 25-row page:

|                          | plan            | buffers | Heap Fetches |
| ------------------------ | --------------- | ------- | ------------ |
| before the migration     | Index Only Scan | 4       | 0            |
| immediately after        | Index Only Scan | 53      | 50           |
| after `VACUUM (ANALYZE)` | Index Only Scan | 4       | 0            |

The plan, the index and the index conditions never change — column order is
intact, `Rows Removed by Filter` stays 0 — so the baselines hold. What changes is
13× the buffer reads until a vacuum runs. `VACUUM` is forbidden inside a
transaction block and Prisma wraps every migration in one, so
`VACUUM (ANALYZE) "public"."conversations"` is a **required manual step after
applying**, alongside the existing `app-roles.sql` re-run. Both are in the
migration's header.

> **Ruling (Architect, 2026-08-23):** accepted, and this is a better answer than
> the `ANALYZE` the ADR implied. Two qualifiers for whoever reads the runbook.
> The regression is **transient, not permanent** — autovacuum resets the
> visibility map on its own schedule, so a forgotten `VACUUM` degrades the inbox
> until then rather than forever. And it is **silent**: same plan, same index,
> same row count, 13x the buffers and no error anywhere. A manual step that fails
> silently needs a way to answer "did it run", so the runbook step should carry a
> verification query — `last_vacuum` / `last_autovacuum` from
> `pg_stat_user_tables` for `conversations`, or an `EXPLAIN (ANALYZE, BUFFERS)`
> showing `Heap Fetches: 0`. Manual-plus-verification is the right weight at
> pre-production scale; the breaking point is the first release that applies this
> to a database with live tenants during business hours, and at that point it
> becomes a post-deploy job rather than a runbook line.

### 4. `ContactResponse.phone` was left non-nullable

The column is nullable now; the published response field is not, and widening it
is a contract change for five render sites in `apps/web`. The ADR rules on the
column and not on the response. TAR-819 kept the contract as it stands and stated
the invariant at the one mapper that publishes it — `contact.mapper.ts` throws if
it ever meets a null, and `OutboundMessageDispatcher.send` does the same for an
unaddressable WhatsApp send. Both are unreachable until TAR-822 creates the first
phone-less contact.

**For the Architect:** widening `ContactResponse.phone` to nullable belongs in
TAR-822, in the release where a client can actually receive one. Confirming that
placement — or moving it earlier — is the open decision.

> **Ruling (Architect, 2026-08-23):** placement confirmed — the widening lands in
> TAR-822, not here. Widening a published response field is only safe in the
> release where a consumer can actually receive the null; doing it in an additive
> schema migration breaks five `apps/web` render sites for no behavioural payoff.
>
> One thing to correct in how it is scheduled. The `contact.mapper.ts` throw is
> an assertion, not error handling: a single phone-less contact anywhere in a
> page fails the whole `GET /api/v1/contacts` response, and
> `contact.phone.toLowerCase()` in the web search path is a second crash site.
> That is exactly right as a tripwire today, and exactly wrong the moment
> TAR-822's first Instagram contact exists. So the widening is not a task inside
> TAR-822 that can slip to the end of it — it is a **prerequisite for TAR-822's
> inbound path**, and must land before the first commit that can create a
> phone-less contact. TAR-822's issue now carries that as its own acceptance
> criterion rather than a note in an ADR.

### Also worth knowing

- **`channels.connected_at` is NULL on every backfilled row.** Nothing recorded
  when Meta attached a number, and `created_at` is when the row was written.
  NULL means "never recorded" rather than "never connected".
- **Only `channel_whatsapp` is granted by the migration.** It describes what
  every tenant can already do. `channel_instagram` / `channel_messenger` are
  granted to nobody except the `scale` demo plan, which is seed data and a
  placeholder — the tiering is TAR-397's.
- **`channel_not_entitled` is not registered yet.** Decision 4 assigns it to
  TAR-821 and TAR-819 is additive-only, so `error-codes.ts` is untouched.
- **`PURGE_ORDER` gained both tables.** `contact_identities` before `contacts`,
  `channels` last of the channel block — which is also the position that stays
  correct once TAR-820 makes `whatsapp_accounts.id` a foreign key into it.

> **Ruling (Architect, 2026-08-23):** both accepted as stated.
> `channels.connected_at` NULL meaning "never recorded" is correct — deriving it
> from `created_at` would publish a timestamp nobody measured, and any console
> that renders connection state must treat NULL as unknown rather than as
> disconnected. The seeded `scale` plan holding `channel_instagram` /
> `channel_messenger` is fixture data so TAR-822/823 have something to run
> against; it is not the tiering, and TAR-397 is not bound by it.

---

## Amendment 2 — the RLS toggle rule, and why no test can hold it

**Author**: Architect, from a Senior Code Reviewer finding on PR #250.
**Date**: 2026-08-23. **Status**: accepted.

TAR-819's expand migration toggled `NO FORCE ROW LEVEL SECURITY` on its three
write targets and not on the two tables it reads, `whatsapp_accounts` and
`contacts`. Both carry `FORCE` and the `tenant_isolation` policy, and no
migration sets `app.tenant_id`. Reproduced on `postgres:16-alpine` with a
non-superuser owner: the source holds a row, the owner sees none, the
`INSERT … SELECT` reports zero and succeeds. Fixed in PR #250; rule 0 in the
Migration strategy section is now where it is stated for future work.

**The part that outlives the fix.** Nothing in the test suite can catch this
class. `docker-compose.yml` sets `POSTGRES_USER: whatsappcrm`, the container's
initdb superuser, so local and CI databases bypass RLS outright and every toggle
in every migration is inert — including the assertion in
`channel-schema.int-spec.ts` that claims to prove the toggle matters, and
including the 120 000-row verification that reported success. A migration is the
one place in this codebase where the tests run as a role the production code
never uses.

**Unresolved and load-bearing:** `render.yaml:99` asserts that the migration
owner on a managed instance _is_ a superuser, which if true makes this class
latent everywhere the app currently deploys, while
`20260815120000_branding_and_custom_domains:135` asserts the opposite as a rule
migrations must follow. The repository states both. This is settled by one query
against the real dev database —
`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user` run as
the migration role — and `rolbypassrls` is the attribute that decides it, not
`rolsuper` alone. Until someone runs it, migrations follow rule 0, because rule 0
is correct under both answers and costs two lines.

**Recommended, not yet scoped:** give the local and CI databases a non-superuser
`migrator` role and run `migrate deploy` as it. It is the only change that closes
the class rather than catching instances of it, and it makes
`verify-tenant-isolation.sql` mean what it claims. Until then, every backfill
closes with a count assertion against its source, which catches the symptom where
it happens.

### Implementation note — a count assertion does not catch this one

**Author**: Database Specialist, 2026-08-23. **Status**: proposed, raised for the
Architect. Recorded here because the closing sentence above is the instruction
TAR-820 inherits, and it is measured to be false for the failure this amendment
is about.

A count assertion against the source is the natural guard and it was the first
thing tried. It passes the broken case. `channels` vs `whatsapp_accounts` reads
**both sides through the same blindfold**: the source is hidden by `FORCE`, the
count comes back `0`, the destination is legitimately `0`, and `0 = 0` commits.
Measured on the same non-superuser fixture that produced the empty backfill
above.

What does catch it is asserting the **precondition** rather than the outcome —
read `pg_class.relforcerowsecurity` for every table the block touches, before
anything reads a row, and raise naming the tables still forced. The catalog is
the one thing RLS cannot hide, so this is true under a superuser owner too, where
no behavioural check can distinguish a complete toggle list from an empty one.
`20260823140000` does both, in that order, and
`channel_backfill_toggles_every_table_it_reads` in `channel-schema.int-spec.ts`
asserts the same rule against the migration's text.

So the count assertion stays and its job is narrower than the sentence above
gives it: it catches a source that is **visible but silently narrowed** — a
predicate that excludes more than it means to, a join that drops rows, a conflict
target that swallows them. It does not catch a source that is hidden, and
TAR-820's re-run should carry the catalog precondition check for that.
