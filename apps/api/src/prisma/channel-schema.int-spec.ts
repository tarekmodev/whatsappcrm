import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-819: the `channels` supertype and `contact_identities`, against a real
 * PostgreSQL as `whatsappcrm_app` (ADR 0013, decisions 1 and 2).
 *
 * This migration is additive and nothing reads it yet, which is exactly why it
 * needs a file of its own: there is no endpoint, no service and no other spec
 * whose failure would notice if any of it regressed between now and TAR-820.
 * Four properties are load-bearing and each is invisible somewhere else in the
 * toolchain:
 *
 *   * **`channels.(kind, routing_key)` is unique across tenants.** It is the one
 *     unique index in this schema that does *not* lead with `tenant_id`, because
 *     it is the lookup that runs before a tenant is known — a webhook names an
 *     endpoint and nothing else. Scoped per tenant instead, two tenants could
 *     both claim a routing key and an inbound message would resolve to either.
 *   * **`contact_identities.(tenant_id, kind, external_id)` is unique *within* a
 *     tenant.** The mirror-image mistake: made global, two tenants could not
 *     both know the same phone number, which is the ordinary case.
 *   * **A channel row carries its WhatsApp account's own id.** The whole
 *     migration plan rests on `conversations.channel_id` being an identity copy
 *     of `whatsapp_account_id` rather than a remap, and a backfill that
 *     generated fresh ids would pass every foreign key and quietly destroy that.
 *   * **`contacts.phone_e164` is nullable and its unique index is still live.**
 *     Half a change here reads as the whole one: the column relaxed without the
 *     index kept is a duplicate-contact bug, and the index kept without the
 *     column relaxed blocks TAR-822 with no failing test to say so.
 *
 * The catalog assertions and the behaviour assertions are deliberately both
 * present. A constraint asserted by name alone passes against one whose body has
 * been widened; a behaviour asserted alone cannot say *which* object enforced
 * it.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and a `tar819-fixture` marker, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '81981981-8198-7819-8819-819819819a01';
const TENANT_B = '81981981-8198-7819-8819-819819819b01';

const WABA_A = '81981981-8198-7819-8819-819819819a02';
const WABA_B = '81981981-8198-7819-8819-819819819b02';

/** The WhatsApp number, and — the point of the whole design — its channel's id. */
const NUMBER_A = '81981981-8198-7819-8819-819819819a03';
const NUMBER_B = '81981981-8198-7819-8819-819819819b03';

const CONTACT_A = '81981981-8198-7819-8819-819819819a04';
const CONTACT_B = '81981981-8198-7819-8819-819819819b04';

const IDENTITY_A = '81981981-8198-7819-8819-819819819a05';
const IDENTITY_B = '81981981-8198-7819-8819-819819819b05';

const CONVERSATION_A = '81981981-8198-7819-8819-819819819a06';

const REQUEST_ID = 'tar819-int-spec';

describe('channel schema', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null, principal: null },
      async () => await work(),
    );
  }

  async function removeFixture(): Promise<void> {
    // Everything below cascades from the tenant, so one delete stays correct as
    // the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar819-fixture-a', name: 'TAR-819 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar819-fixture-b', name: 'TAR-819 fixture B', status: 'active' },
      ],
    });

    await systemPrisma.whatsappBusinessAccount.createMany({
      data: [
        { id: WABA_A, tenantId: TENANT_A, wabaId: 'tar819-fixture-waba-a' },
        { id: WABA_B, tenantId: TENANT_B, wabaId: 'tar819-fixture-waba-b' },
      ],
    });

    await systemPrisma.whatsappAccount.createMany({
      data: [
        {
          id: NUMBER_A,
          tenantId: TENANT_A,
          whatsappBusinessAccountId: WABA_A,
          phoneNumberId: 'tar819-fixture-pnid-a',
          displayPhoneNumber: '+15550000801',
          verifiedName: 'TAR-819 fixture A',
          status: 'connected',
        },
        {
          id: NUMBER_B,
          tenantId: TENANT_B,
          whatsappBusinessAccountId: WABA_B,
          phoneNumberId: 'tar819-fixture-pnid-b',
          displayPhoneNumber: '+15550000802',
          status: 'disconnected',
        },
      ],
    });

    await systemPrisma.contact.createMany({
      data: [
        { id: CONTACT_A, tenantId: TENANT_A, phoneE164: '+15551110801' },
        { id: CONTACT_B, tenantId: TENANT_B, phoneE164: '+15551110801' },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await systemPrisma.conversation.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.contactIdentity.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.channel.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
  });

  describe('the catalog', () => {
    it('keeps (kind, routing_key) unique across tenants, not within one', async () => {
      const [index] = await systemPrisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'channels'
          AND indexname = 'channels_kind_routing_key_key'
      `;

      expect(index?.indexdef).toContain('CREATE UNIQUE INDEX');
      // Asserted as the whole column list rather than with `toContain`, because
      // a `(tenant_id, kind, routing_key)` index contains this one's text and
      // would pass a substring check while being the bug.
      expect(index?.indexdef).toContain('(kind, routing_key)');
      expect(index?.indexdef).not.toContain('tenant_id');
    });

    it('keeps (tenant_id, kind, external_id) unique within a tenant, not across', async () => {
      const [index] = await systemPrisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'contact_identities'
          AND indexname = 'contact_identities_tenant_id_kind_external_id_key'
      `;

      expect(index?.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(index?.indexdef).toContain('(tenant_id, kind, external_id)');
    });

    it.each([
      ['channels', 'channels_tenant_id_id_key'],
      ['contact_identities', 'contact_identities_tenant_id_id_key'],
    ])('gives %s the (tenant_id, id) key composite foreign keys need', async (_table, index) => {
      const rows = await systemPrisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ${index}
      `;

      expect(rows).toHaveLength(1);
    });

    it('carries the tenant_isolation policy, FORCEd, on both new tables', async () => {
      const rows = await systemPrisma.$queryRaw<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('channels', 'contact_identities')
        ORDER BY c.relname
      `;

      // FORCE matters as much as ENABLE: without it the table owner — which is
      // what a migration and a psql session run as — is exempt from its own
      // policy (`20260810140000_tenant_isolation_rls`).
      expect(rows).toEqual([
        { relname: 'channels', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'contact_identities', relrowsecurity: true, relforcerowsecurity: true },
      ]);

      const policies = await systemPrisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
          AND tablename IN ('channels', 'contact_identities')
        ORDER BY tablename
      `;

      expect(policies.map((policy) => policy.tablename)).toEqual([
        'channels',
        'contact_identities',
      ]);
    });

    it('leaves contacts.phone_e164 nullable with its unique index still live', async () => {
      const [column] = await systemPrisma.$queryRaw<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'phone_e164'
      `;

      expect(column?.is_nullable).toBe('YES');

      // The other half of the same change. TAR-820 moves inbound resolution onto
      // `contact_identities` and drops this; until then it is what stops two
      // contacts sharing a number, and relaxing the column without keeping it
      // would be a duplicate-contact bug with no failing test.
      const [index] = await systemPrisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'contacts'
          AND indexname = 'contacts_tenant_id_phone_e164_key'
      `;

      expect(index?.indexdef).toContain('CREATE UNIQUE INDEX');
    });

    it('leaves conversations.channel_id nullable, so today’s writers still insert', async () => {
      const [column] = await systemPrisma.$queryRaw<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'conversations'
          AND column_name = 'channel_id'
      `;

      // NOT NULL here is TAR-820's, and landing it early breaks the inbound
      // writer — which sets `whatsapp_account_id` alone — on the next message.
      expect(column?.is_nullable).toBe('YES');
    });

    it('keeps the three documented inbox indexes exactly as they were', async () => {
      const rows = await systemPrisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'conversations'
      `;
      const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));

      // ADR 0013 states that `whatsapp_account_id` "leads all three hot inbox
      // indexes" and that the channel migration therefore rebuilds them. It
      // leads none of them — it appears in exactly one index on this table, the
      // unique below — so nothing here was rebuilt and the measured plans in
      // `schema.prisma`'s doc comments are untouched. This assertion is what
      // makes that a checked claim: column order is the whole content of those
      // measurements.
      expect(byName.get('conversations_tenant_id_status_last_message_at_id_idx')).toContain(
        '(tenant_id, status, last_message_at DESC, id DESC)',
      );
      expect(byName.get('conversations_tenant_assigned_user_inbox_idx')).toContain(
        '(tenant_id, assigned_user_id, status, last_message_at DESC, id DESC)',
      );
      expect(byName.get('conversations_tenant_assigned_team_inbox_idx')).toContain(
        '(tenant_id, assigned_team_id, status, last_message_at DESC, id DESC)',
      );

      // Both thread keys are live during the window: the old one is what
      // actually enforces "one thread per contact per number" while `channel_id`
      // is still nullable, and TAR-820's contract migration drops it.
      expect(byName.get('conversations_tenant_id_whatsapp_account_id_contact_id_key')).toContain(
        '(tenant_id, whatsapp_account_id, contact_id)',
      );
      expect(byName.get('conversations_tenant_id_channel_id_contact_id_key')).toContain(
        '(tenant_id, channel_id, contact_id)',
      );
    });
  });

  /**
   * The backfill, run against rows it has never seen.
   *
   * A CI database is migrated while it is empty, so asserting "every WhatsApp
   * number has a channel" after the fact proves nothing — there were none. So
   * these tests take the backfill block **out of the migration file as written**
   * and re-execute it over the fixture rows above, which were created after the
   * migration ran and are therefore exactly the pre-migration shape it has to
   * handle.
   *
   * Two things fall out of doing it this way. The statements are the ones that
   * shipped rather than a paraphrase, so a paraphrase cannot drift away from
   * them; and re-running them at all is the "twice in a row" claim in the
   * migration's own header, checked rather than asserted.
   *
   * It runs as the **owner** over `DATABASE_URL`, not as either application
   * role, because the block issues `ALTER TABLE … FORCE ROW LEVEL SECURITY` and
   * that needs ownership. The same connection `db-rollback.int-spec.ts` uses.
   *
   * ⚠️ **These tests cannot prove the FORCE toggle is complete, and nothing
   * here can.** `docker-compose.yml` connects as the container's initdb
   * superuser, and a superuser bypasses RLS outright — so the toggles are inert
   * against this database and the backfill would pass identically with the list
   * empty. `channel_backfill_toggles_every_table_it_reads` below is the guard
   * that covers it, by checking the block's text against the catalog rather than
   * by running anything.
   */
  describe('the backfill', () => {
    let backfill: string;

    beforeAll(() => {
      backfill = extractDoBlock(
        '20260823140000_channel_supertype_and_contact_identities',
        // The block is identified by its DECLARE list.
        'DO $$\nDECLARE\n    channel_rows      bigint;',
        'The backfill block was not found in the channel migration. It is identified by its ' +
          'DECLARE list; if that changed, update the anchor here rather than deleting this ' +
          'test — it is the only thing that runs the backfill over data.',
      );
    });

    beforeEach(async () => {
      await withOwner((client) => client.query(backfill));
    });

    it('gives a WhatsApp number a channel under that number’s own id', async () => {
      // The property the whole plan rests on. A backfill that generated fresh
      // ids would satisfy every foreign key and silently turn TAR-820's column
      // swap into a remap.
      await expect(
        systemPrisma.channel.findUnique({
          where: { id: NUMBER_A },
          select: { tenantId: true, kind: true, status: true, routingKey: true },
        }),
      ).resolves.toEqual({
        tenantId: TENANT_A,
        kind: 'whatsapp',
        // Copied from `whatsapp_accounts.status`, through text rather than by
        // ordinal — the fixture's second number is `disconnected` and the first
        // `connected`, so an ordinal cast that happened to align would still
        // pass here and this pair is what makes both values load-bearing.
        status: 'connected',
        routingKey: 'tar819-fixture-pnid-a',
      });

      await expect(
        systemPrisma.channel.findUnique({ where: { id: NUMBER_B }, select: { status: true } }),
      ).resolves.toEqual({ status: 'disconnected' });
    });

    it('prefers the verified name and falls back to the display phone number', async () => {
      const named = await systemPrisma.channel.findUnique({
        where: { id: NUMBER_A },
        select: { displayName: true },
      });
      const unnamed = await systemPrisma.channel.findUnique({
        where: { id: NUMBER_B },
        select: { displayName: true },
      });

      expect(named?.displayName).toBe('TAR-819 fixture A');
      // Fixture B has no verified name at all; the whitespace case is what
      // `NULLIF(btrim(...), '')` is for, and both land on the phone number.
      expect(unnamed?.displayName).toBe('+15550000802');
    });

    it('leaves connected_at null rather than inventing one', async () => {
      // Nothing recorded when Meta attached the number, and `created_at` is when
      // the row was written. NULL here means "never recorded", which is the
      // truth; a derived value would be an invention in the first column anyone
      // would trust.
      await expect(
        systemPrisma.channel.findUnique({
          where: { id: NUMBER_A },
          select: { connectedAt: true },
        }),
      ).resolves.toEqual({ connectedAt: null });
    });

    it('gives every contact with a phone number a whatsapp identity', async () => {
      const identity = await systemPrisma.contactIdentity.findUnique({
        where: {
          tenantId_kind_externalId: {
            tenantId: TENANT_A,
            kind: 'whatsapp',
            externalId: '+15551110801',
          },
        },
        select: { contactId: true, displayName: true },
      });

      expect(identity?.contactId).toBe(CONTACT_A);
      expect(identity?.displayName).toBeNull();

      // Tenant B's contact carries the same number and is a different person.
      await expect(
        systemPrisma.contactIdentity.count({ where: { contactId: CONTACT_B } }),
      ).resolves.toBe(1);
    });

    it('generates UUIDv7 ids for the identities it creates', async () => {
      const [row] = await systemPrisma.$queryRaw<{ version: number }[]>`
        SELECT (('x' || substr(replace(id::text, '-', ''), 13, 1))::bit(4))::int AS version
        FROM public.contact_identities
        WHERE tenant_id = ${TENANT_A}::uuid
      `;

      // A v4 would work — nothing sorts this table by id — but a v4 among v7s
      // reads as a different kind of row, and the expression in the migration is
      // the same one `20260813130000_sla_pause_accounting_and_alerts` uses.
      expect(row?.version).toBe(7);
    });

    it('copies whatsapp_account_id into channel_id byte for byte', async () => {
      await systemPrisma.conversation.create({
        data: {
          id: CONVERSATION_A,
          tenantId: TENANT_A,
          whatsappAccountId: NUMBER_A,
          contactId: CONTACT_A,
        },
      });

      // Written the way today's inbound writer writes it — `channel_id` unset —
      // and then picked up by the same block, which is what TAR-820's migration
      // will do for every row opened during the window.
      await withOwner((client) => client.query(backfill));

      await expect(
        systemPrisma.conversation.findUnique({
          where: { id: CONVERSATION_A },
          select: { channelId: true },
        }),
      ).resolves.toEqual({ channelId: NUMBER_A });
    });

    it('restores FORCE row level security on every table it toggled', async () => {
      // The toggle is the sharpest edge in the migration: left off, both new
      // tables and the product's hottest one would be readable by the owner
      // across tenants with nothing to say so.
      const rows = await systemPrisma.$queryRaw<{ relname: string; forced: boolean }[]>`
        SELECT c.relname, c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('channels', 'contact_identities', 'contacts',
                            'conversations', 'whatsapp_accounts')
        ORDER BY c.relname
      `;

      expect(rows).toEqual([
        { relname: 'channels', forced: true },
        { relname: 'contact_identities', forced: true },
        { relname: 'contacts', forced: true },
        { relname: 'conversations', forced: true },
        { relname: 'whatsapp_accounts', forced: true },
      ]);
    });

    /**
     * The guard for the defect this test file could not otherwise see.
     *
     * `FORCE ROW LEVEL SECURITY` binds the **table owner**, and the owner is the
     * role a migration runs as. A `SELECT` from a FORCE-RLS table with no
     * `app.tenant_id` set therefore returns zero rows for the migration too — so
     * `INSERT … SELECT` inserts nothing and reports success. Reproduced on
     * `postgres:16-alpine` with a non-superuser owner and this schema's policy
     * copied verbatim: source holds 1 row, owner reads 0, insert reports 0.
     *
     * The original block toggled only the three tables it **writes** and left
     * `whatsapp_accounts` and `contacts`, which it reads, FORCEd.
     *
     * Nothing that executes SQL can catch that here: `docker-compose.yml`
     * connects as the initdb superuser and `render.yaml` records that a managed
     * instance's migration owner is one as well, and a superuser bypasses RLS
     * entirely. So this asserts the **rule** instead — every table the block
     * names that has FORCE enabled must also appear in a `NO FORCE` toggle
     * inside it — against the migration's own text and the live catalog. That is
     * checkable everywhere, and it is the invariant a future edit would break.
     */
    it('toggles every FORCE-RLS table it reads, not only the ones it writes', async () => {
      const named = new Set(
        [...backfill.matchAll(/"public"\."([a-z_]+)"/g)].map((match) => match[1] as string),
      );
      const toggled = new Set(
        [
          ...backfill.matchAll(/ALTER TABLE "public"\."([a-z_]+)" NO FORCE ROW LEVEL SECURITY/g),
        ].map((match) => match[1] as string),
      );

      // Sanity on the regexes themselves: a block that named nothing would pass
      // the assertion below vacuously.
      expect(named.size).toBeGreaterThanOrEqual(5);
      expect(toggled.size).toBeGreaterThanOrEqual(5);

      const forced = await systemPrisma.$queryRaw<{ relname: string }[]>`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
      `;
      const forcedNames = new Set(forced.map((row) => row.relname));

      const unprotected = [...named]
        .filter((table) => forcedNames.has(table) && !toggled.has(table))
        .sort();

      expect(unprotected).toEqual([]);
    });
  });

  /**
   * The fifth entitlement write site (`20260823140100_channel_entitlement_features`
   * section 3), extracted and run the same way as the backfill above.
   *
   * ADR 0013 decision 4 names four write sites. `plans.entitlements` is a fifth
   * and it is the one that makes the other four durable:
   * `SubscriptionSyncService.copyEntitlements` **replaces**
   * `tenant_entitlements.entitlements` wholesale from `plans.entitlements` on
   * every subscription event naming a plan. A catalogue row seeded before this
   * release therefore overwrites the tenant backfill with an array that has no
   * `channel_whatsapp` — and once TAR-821's fail-closed gate lands, that is
   * WhatsApp connect refused for a paying tenant on the next webhook.
   *
   * Seed data cannot cover it: `db:seed` is in neither `preDeployCommand`.
   */
  describe('the plan catalogue backfill', () => {
    const PLAN_ID = '81981981-8198-7819-8819-819819819c01';

    const LIMITS = {
      seats: 3,
      conversationsPerPeriod: 1000,
      whatsappNumbers: 1,
      teams: 2,
      knowledgeDocuments: 10,
    };

    let planBackfill: string;

    beforeAll(() => {
      planBackfill = extractDoBlock(
        '20260823140100_channel_entitlement_features',
        'DO $$\nDECLARE\n    updated bigint;\nBEGIN\n    UPDATE "public"."plans"',
        'The plan-catalogue backfill was not found in the entitlement migration. It is the ' +
          'DO block whose UPDATE targets plans; if it moved, update the anchor here rather ' +
          'than deleting this test — it is the only thing that covers the fifth write site.',
      );
    });

    beforeEach(async () => {
      await systemPrisma.plan.deleteMany({ where: { id: PLAN_ID } });
    });

    afterAll(async () => {
      await systemPrisma.plan.deleteMany({ where: { id: PLAN_ID } });
    });

    it('appends channel_whatsapp to a plan seeded before this release', async () => {
      await systemPrisma.plan.create({
        data: {
          id: PLAN_ID,
          key: 'tar819fixture',
          name: 'TAR-819 fixture plan',
          priceMinorUnits: 2900,
          entitlements: { features: ['assignment_rules', 'sla_policies'], limits: LIMITS },
        },
      });

      await withOwner((client) => client.query(planBackfill));

      const plan = await systemPrisma.plan.findUnique({
        where: { id: PLAN_ID },
        select: { entitlements: true },
      });

      expect((plan?.entitlements as { features: string[] }).features).toEqual([
        'assignment_rules',
        'sla_policies',
        'channel_whatsapp',
      ]);
    });

    it('covers a retired plan, which is the one nobody is watching', async () => {
      // `is_active` governs what may be bought. `copyEntitlements` reads the row
      // the subscription names, so a tenant sitting on a withdrawn plan is
      // exactly the tenant a filtered backfill would strand.
      await systemPrisma.plan.create({
        data: {
          id: PLAN_ID,
          key: 'tar819fixture',
          name: 'TAR-819 retired plan',
          priceMinorUnits: 2900,
          isActive: false,
          entitlements: { features: ['assignment_rules'], limits: LIMITS },
        },
      });

      await withOwner((client) => client.query(planBackfill));

      const plan = await systemPrisma.plan.findUnique({
        where: { id: PLAN_ID },
        select: { entitlements: true },
      });

      expect((plan?.entitlements as { features: string[] }).features).toContain('channel_whatsapp');
    });

    it('leaves a plan that already names it alone, twice over', async () => {
      await systemPrisma.plan.create({
        data: {
          id: PLAN_ID,
          key: 'tar819fixture',
          name: 'TAR-819 fixture plan',
          priceMinorUnits: 2900,
          entitlements: {
            features: ['channel_whatsapp', 'assignment_rules'],
            limits: LIMITS,
          },
        },
      });

      await withOwner((client) => client.query(planBackfill));
      await withOwner((client) => client.query(planBackfill));

      const plan = await systemPrisma.plan.findUnique({
        where: { id: PLAN_ID },
        select: { entitlements: true },
      });

      // Order preserved and no duplicate: the append is conditional, so applying
      // the migration twice is a no-op rather than a row with two copies.
      expect((plan?.entitlements as { features: string[] }).features).toEqual([
        'channel_whatsapp',
        'assignment_rules',
      ]);
    });
  });

  describe('the constraints, by behaviour', () => {
    async function createChannelA(routingKey: string): Promise<void> {
      await systemPrisma.channel.create({
        data: {
          id: NUMBER_A,
          tenantId: TENANT_A,
          kind: 'whatsapp',
          status: 'connected',
          displayName: 'TAR-819 fixture A',
          routingKey,
        },
      });
    }

    it('refuses the same routing key in a second tenant', async () => {
      await createChannelA('tar819-shared-routing-key');

      // The property the inbound resolver depends on: nothing on a Meta delivery
      // names a tenant except the endpoint it arrived on, so two tenants holding
      // one routing key means a message that resolves to either.
      await expect(
        systemPrisma.channel.create({
          data: {
            id: NUMBER_B,
            tenantId: TENANT_B,
            kind: 'whatsapp',
            displayName: 'TAR-819 fixture B',
            routingKey: 'tar819-shared-routing-key',
          },
        }),
      ).rejects.toThrow();
    });

    it('allows the same routing key under a different kind', async () => {
      await createChannelA('tar819-shared-routing-key');

      // A Page id and an IG professional account id are different namespaces; a
      // collision between them is a coincidence rather than a conflict, which is
      // why the unique index is scoped by kind.
      await expect(
        systemPrisma.channel.create({
          data: {
            id: NUMBER_B,
            tenantId: TENANT_B,
            kind: 'instagram',
            displayName: 'TAR-819 fixture B',
            routingKey: 'tar819-shared-routing-key',
          },
        }),
      ).resolves.toMatchObject({ kind: 'instagram' });
    });

    it('lets two tenants know the same person, and refuses a duplicate within one', async () => {
      await systemPrisma.contactIdentity.create({
        data: {
          id: IDENTITY_A,
          tenantId: TENANT_A,
          contactId: CONTACT_A,
          kind: 'whatsapp',
          externalId: '+15551110801',
        },
      });

      // The ordinary case, and the mirror image of the routing-key rule: one
      // phone number is one person to each tenant that talks to them.
      await expect(
        systemPrisma.contactIdentity.create({
          data: {
            id: IDENTITY_B,
            tenantId: TENANT_B,
            contactId: CONTACT_B,
            kind: 'whatsapp',
            externalId: '+15551110801',
          },
        }),
      ).resolves.toMatchObject({ tenantId: TENANT_B });

      await expect(
        systemPrisma.contactIdentity.create({
          data: {
            id: '81981981-8198-7819-8819-819819819a07',
            tenantId: TENANT_A,
            contactId: CONTACT_A,
            kind: 'whatsapp',
            externalId: '+15551110801',
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses an identity naming another tenant’s contact', async () => {
      // The one integrity property RLS cannot provide: the foreign key is
      // composite, so a contact id from another tenant fails in the database
      // rather than being caught by whichever handler happened to remember.
      await expect(
        systemPrisma.contactIdentity.create({
          data: {
            id: IDENTITY_A,
            tenantId: TENANT_A,
            contactId: CONTACT_B,
            kind: 'whatsapp',
            externalId: '+15559990801',
          },
        }),
      ).rejects.toThrow();
    });

    it('accepts a conversation with no channel_id, and refuses an unknown one', async () => {
      // Today's writer, unchanged. This is what "additive" means for this
      // migration, and the composite foreign key tolerates it because a
      // MATCH SIMPLE key skips the check when any of its columns is NULL.
      await expect(
        systemPrisma.conversation.create({
          data: {
            id: CONVERSATION_A,
            tenantId: TENANT_A,
            whatsappAccountId: NUMBER_A,
            contactId: CONTACT_A,
          },
        }),
      ).resolves.toMatchObject({ channelId: null });

      await expect(
        systemPrisma.conversation.update({
          where: { id: CONVERSATION_A },
          data: { channelId: '81981981-8198-7819-8819-8198198199ff' },
        }),
      ).rejects.toThrow();
    });
  });

  describe('tenant isolation', () => {
    it('shows a tenant only its own channels and identities', async () => {
      await systemPrisma.channel.createMany({
        data: [
          {
            id: NUMBER_A,
            tenantId: TENANT_A,
            kind: 'whatsapp',
            displayName: 'A',
            routingKey: 'tar819-isolation-a',
          },
          {
            id: NUMBER_B,
            tenantId: TENANT_B,
            kind: 'whatsapp',
            displayName: 'B',
            routingKey: 'tar819-isolation-b',
          },
        ],
      });

      const seen = await asTenant(TENANT_A, () =>
        tenantPrisma.channel.findMany({ select: { id: true } }),
      );

      // Neither table is `system-only`: they are absent from `MODEL_POLICIES`,
      // which is how `tenant-scope.extension.ts` spells "tenant-scoped", so this
      // read goes through `TenantPrisma` and the policy is what narrows it.
      expect(seen).toEqual([{ id: NUMBER_A }]);

      await expect(
        asTenant(TENANT_A, () =>
          tenantPrisma.channel.findFirst({ where: { id: NUMBER_B }, select: { id: true } }),
        ),
      ).resolves.toBeNull();
    });

    it('refuses a write carrying another tenant’s id', async () => {
      await expect(
        asTenant(TENANT_A, () =>
          tenantPrisma.channel.create({
            data: {
              id: NUMBER_B,
              tenantId: TENANT_B,
              kind: 'whatsapp',
              displayName: 'B',
              routingKey: 'tar819-forged',
            },
          }),
        ),
      ).rejects.toThrow();
    });
  });
});

/**
 * One `DO $$ … $$;` block, lifted out of a migration file **as shipped**.
 *
 * Running the statements that were released, rather than a paraphrase of them,
 * is the whole point: a paraphrase drifts, and these blocks are also what
 * TAR-820's migration re-runs verbatim. `anchor` is matched literally and the
 * block ends at the first `\n$$;` after it.
 */
function extractDoBlock(migration: string, anchor: string, missing: string): string {
  const file = join(__dirname, '../../prisma/migrations', migration, 'migration.sql');
  const sql = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const start = sql.indexOf(anchor);

  if (start === -1) {
    throw new Error(missing);
  }

  const end = sql.indexOf('\n$$;', start);

  return sql.slice(start, end + '\n$$;'.length);
}

/**
 * One connection as the migration's own role — the table owner — for the
 * statements that need `ALTER TABLE`. `pg` directly rather than Prisma, because
 * the backfill is a multi-statement `DO` block and Prisma's raw helpers send the
 * extended protocol, which refuses one.
 */
async function withOwner<T>(use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: requireEnv('DATABASE_URL') });
  await client.connect();

  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
