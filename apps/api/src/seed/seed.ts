#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { mediaObjectKey } from '../media/media-object-key';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { TenantProvisioningService } from '../tenancy/tenant-provisioning.service';
import { WhatsAppAccessTokenCipher } from '../whatsapp/access-token.cipher';
import {
  DEMO_ACCESS_TOKEN,
  DEMO_PLANS,
  DEMO_SUBSCRIPTION_IDS,
  demoDataset,
  type DemoTenant,
} from './demo-dataset';

/**
 * Seeds the demo dataset into a local database (TAR-46).
 *
 * ```
 * pnpm db:seed
 * ```
 *
 * Runs against the harness TAR-42 built — `pnpm db:up`, `pnpm db:migrate:deploy`,
 * `pnpm db:roles`, `pnpm db:roles:login` — and needs all four to have happened.
 * `demo-dataset.ts` holds the data; this file holds the decisions about how it
 * reaches the database.
 *
 * ---------------------------------------------------------------------------
 * It writes through the application's own clients, and that is the point
 * ---------------------------------------------------------------------------
 *
 * A seed that connects as the migration owner would be shorter. It would also
 * be worthless as evidence: locally the owner is a superuser, and a superuser
 * skips row-level security entirely, so such a seed would happily write rows
 * that the app can then never read — a missing `system_unrestricted` policy, a
 * table `pnpm db:roles` was never re-run for, a `tenant_id` on the wrong row.
 * Every one of those is a green seed followed by an empty console.
 *
 * So the split here is the same one the API uses (TAR-49):
 *
 *   `SystemPrisma`   the three tables that carry no tenant policy — `tenants`
 *                    itself, and the platform-wide `plans` catalogue. Nothing
 *                    else.
 *   `TenantPrisma`   every tenant-scoped row, as `whatsappcrm_app`, under RLS,
 *                    with `app.tenant_id` set exactly as a request sets it.
 *
 * The consequence worth stating: **a seed that finishes is a proof that the app
 * role can write and read this data.** If `pnpm db:roles` has not been re-run
 * after a migration that added a table, the seed fails on that table with a
 * permission error rather than leaving a half-populated database behind.
 *
 * Tenants themselves go through `TenantProvisioningService` — the same service
 * behind `POST /api/v1/admin/tenants` — rather than a `tenant.create()` here.
 * A seeded tenant is then indistinguishable from a provisioned one: same
 * settings row, same platform subdomain derived from the slug, same `active`
 * status, same advisory lock. Two ways to create a tenant is one way too many.
 *
 * ---------------------------------------------------------------------------
 * Re-running it
 * ---------------------------------------------------------------------------
 *
 * The seed **owns** its two slugs and nothing else. It deletes those two tenant
 * rows and lets the schema's `ON DELETE CASCADE` take their data with them, then
 * writes everything again. That is what makes it idempotent without every
 * insert becoming an upsert, and it is also why the delete is by slug rather
 * than by anything broader: a `TRUNCATE`, or a delete of "all tenants", would
 * take a developer's own scratch tenant with it.
 *
 * `plans` is upserted rather than deleted — it is platform-wide catalogue data
 * that another tenant's subscription may already point at.
 *
 * ---------------------------------------------------------------------------
 * Where it refuses to run
 * ---------------------------------------------------------------------------
 *
 * Under `NODE_ENV=production` it stops, because deleting two tenants by slug is
 * a destructive operation and "production" is the one environment where the
 * slug it deletes might belong to somebody. `--force` overrides it, deliberately
 * out of the way, for the case of a production-mode container pointed at a
 * scratch database.
 *
 * It prints the host and database it is about to write to before it writes
 * anything, so the answer to "which database did I just seed" is in the output
 * rather than in an environment variable somebody has to go and read.
 */

/**
 * Matches `jest.int.setup.cjs` and `prisma.config.mjs`: one `.env`, at the root.
 * Resolved from `apps/api/dist/seed`, which is where this file runs from — the
 * seed is compiled by `nest build` along with the rest of `src`, so there is no
 * TypeScript runner to install and no second toolchain to keep working.
 */
const ROOT_ENV = path.resolve(__dirname, '../../../../.env');

const REQUEST_ID = 'seed';

/** Long enough for one tenant's whole dataset; short enough to fail rather than hang. */
const TENANT_TRANSACTION_TIMEOUT_MS = 30_000;

interface SeededTenantSummary {
  slug: string;
  hostname: string;
  users: number;
  conversations: number;
  messages: number;
  tickets: number;
}

async function main(): Promise<void> {
  loadRepositoryEnv();

  const force = process.argv.includes('--force');

  if (process.env.NODE_ENV === 'production' && !force) {
    fail(
      'Refusing to seed with NODE_ENV=production.\n' +
        'This script deletes the tenants with slugs "northwind" and "southwind" before rewriting them.\n' +
        'If this really is a scratch database, re-run with --force.',
    );
  }

  const systemUrl = requireEnv('SYSTEM_DATABASE_URL');
  const appUrl = requireEnv('APP_DATABASE_URL');

  // Read before the first write, so the output answers "which database" without
  // anyone having to go and read an environment variable. Credentials are
  // stripped rather than printed.
  console.log(`Seeding ${describeTarget(appUrl)}`);

  const tenantContext = new TenantContextService();
  const systemPrisma = createPrismaClient('system', systemUrl);
  const tenantBase = createPrismaClient('tenant', appUrl);
  const tenantPrisma = withTenantScope(tenantBase, tenantContext);

  // `ConfigService` with no module reads `process.env`, which `loadRepositoryEnv`
  // has just populated. Both of these classes are written to be constructible
  // outside Nest — the cipher says so in its own comments — so the seed reuses
  // them rather than restating the hostname rule or the AES construction.
  const config = new ConfigService();
  const provisioning = new TenantProvisioningService(systemPrisma, config);
  const cipher = new WhatsAppAccessTokenCipher(config);

  const dataset = demoDataset(new Date());
  const summaries: SeededTenantSummary[] = [];

  try {
    await resetDemoTenants(
      systemPrisma,
      dataset.map((tenant) => tenant.slug),
    );
    await upsertPlans(systemPrisma);

    // Slug → the id provisioning assigned it. Held rather than re-read: it is
    // what every scoped write below runs under, and reading it back from
    // `tenants` would be a second source of truth for the same answer.
    const tenantIds = new Map<string, string>();

    for (const tenant of dataset) {
      const provisioned = await provisioning.provision({
        slug: tenant.slug,
        name: tenant.name,
        timezone: tenant.timezone,
        locale: tenant.locale,
      });

      // The reset above deleted this slug, so provisioning must have created it.
      // Anything else means a tenant with this slug appeared between the two
      // statements, and the rest of the seed would be writing into its rows.
      if (!provisioned.created) {
        fail(
          `Tenant "${tenant.slug}" already existed after the reset (id ${provisioned.tenant.id}).\n` +
            'Something else is writing to this database. Nothing further has been seeded.',
        );
      }

      const tenantId = provisioned.tenant.id;
      tenantIds.set(tenant.slug, tenantId);

      await tenantContext.run({ requestId: REQUEST_ID, tenantId, userId: null }, () =>
        writeTenantData(tenantPrisma, cipher, tenant, tenantId),
      );

      summaries.push({
        slug: tenant.slug,
        hostname: provisioned.tenant.primaryHostname,
        users: tenant.users.length,
        conversations: tenant.conversations.length,
        messages: tenant.messages.length,
        tickets: tenant.tickets.length,
      });
    }

    await verify(tenantPrisma, tenantContext, dataset, tenantIds);
    report(summaries);
  } finally {
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  }
}

/**
 * Everything for one tenant, in one transaction, with `app.tenant_id` set once
 * at its start.
 *
 * `$tenantTransaction` rather than a sequence of statements for two reasons.
 * Atomicity: a failure halfway leaves no tenant half-populated, so a re-run
 * starts from a known state rather than from wreckage. And cost: the per-statement
 * path opens a transaction and sets the GUC for *every* call, which for the
 * twenty-odd writes below is twenty extra round trips to say the same thing.
 *
 * The client handed in is the un-extended transaction client, so the model
 * policies in `tenant-scope.extension.ts` do not apply inside it — RLS still
 * does, which is the layer that matters here. `tenant_id` is stamped onto every
 * row from the single `tenant.id` above rather than carried per row.
 */
async function writeTenantData(
  tenantPrisma: TenantPrisma,
  cipher: WhatsAppAccessTokenCipher,
  tenant: DemoTenant,
  tenantId: string,
): Promise<void> {
  const scope = <T>(rows: readonly T[]): (T & { tenantId: string })[] =>
    rows.map((row) => ({ ...row, tenantId }));

  await tenantPrisma.$tenantTransaction(
    async (tx) => {
      // Provisioning wrote timezone and locale; business hours belong to the
      // tenant's own settings and are added rather than re-created, so this
      // stays an update of the row provisioning already owns.
      await tx.tenantSettings.update({
        where: { tenantId },
        data: { businessHours: tenant.businessHours },
      });

      await tx.tenantBranding.create({ data: { ...tenant.branding, tenantId } });

      // Order follows the foreign keys: users and teams before the memberships
      // and assignments that point at them, business accounts before numbers,
      // conversations before messages, tickets before their events.
      await tx.user.createMany({ data: scope(tenant.users) });
      await tx.team.createMany({ data: scope(tenant.teams) });
      await tx.teamMember.createMany({ data: scope(tenant.teamMembers) });

      await tx.whatsappBusinessAccount.createMany({
        data: tenant.businessAccounts.map((account) => ({
          ...account,
          tenantId,
          // Encrypted here rather than in the dataset: the ciphertext is a fresh
          // IV per run and is bound to this WABA's `waba_id` as AAD, so it
          // cannot be a literal and cannot be copied between rows.
          accessTokenEncrypted: cipher.encrypt(DEMO_ACCESS_TOKEN, account.wabaId),
        })),
      });
      await tx.whatsappAccount.createMany({ data: scope(tenant.whatsappAccounts) });
      await tx.messageTemplate.createMany({ data: scope(tenant.messageTemplates) });

      await tx.tag.createMany({ data: scope(tenant.tags) });
      await tx.customFieldDef.createMany({ data: scope(tenant.customFieldDefs) });
      await tx.contact.createMany({ data: scope(tenant.contacts) });
      await tx.contactTag.createMany({ data: scope(tenant.contactTags) });

      await tx.conversation.createMany({ data: scope(tenant.conversations) });
      await tx.message.createMany({ data: scope(tenant.messages) });
      // The storage key is derived rather than written into the dataset: it
      // contains the tenant id, which provisioning assigns above, and building
      // it with the same helper the upload path uses is what keeps a seeded
      // object addressable by the same rules as a real one (TAR-20e).
      await tx.mediaObject.createMany({
        data: tenant.mediaObjects.map((object) => ({
          ...object,
          tenantId,
          storageKey: mediaObjectKey(tenantId, object.kind, object.id as string),
        })),
      });
      await tx.messageAttachment.createMany({ data: scope(tenant.attachments) });
      await tx.internalNote.createMany({ data: scope(tenant.internalNotes) });

      await tx.ticket.createMany({ data: scope(tenant.tickets) });
      await tx.ticketEvent.createMany({ data: scope(tenant.ticketEvents) });

      if (tenant.nextTicketNumber !== null) {
        // Left one past the highest seeded number. TAR-73's allocator reads this
        // row and hands out `next_number`; seeding tickets without moving it
        // would make the first ticket created in the console collide on
        // `UNIQUE (tenant_id, number)`.
        await tx.ticketCounter.create({
          data: { tenantId, nextNumber: tenant.nextTicketNumber },
        });
      }

      await writeSubscription(tx, tenant, tenantId);
      await tx.auditLog.createMany({ data: scope(tenant.auditLogs) });
    },
    { timeout: TENANT_TRANSACTION_TIMEOUT_MS },
  );
}

/**
 * The subscription and its usage counters.
 *
 * `plans` is platform-wide and carries no tenant column, so the plan is looked
 * up by key rather than named by id from the dataset — a subscription pointing
 * at a plan id that is not in the catalogue is the one referential mistake this
 * table can make.
 *
 * The period is the subscription's own, anchored to the row's creation rather
 * than to the calendar month, because that is what `usage_counters.period_start`
 * means (TAR-39, usage rules).
 */
async function writeSubscription(
  tx: Prisma.TransactionClient,
  tenant: DemoTenant,
  tenantId: string,
): Promise<void> {
  const plan = await tx.plan.findUnique({
    where: { key: tenant.subscription.planKey },
    select: { id: true },
  });

  if (plan === null) {
    // Thrown rather than `fail()`ed: this runs inside the tenant's transaction,
    // and exiting the process there would leave the rollback to the server's
    // disconnect handling instead of happening because we asked for it.
    throw new Error(
      `Plan "${tenant.subscription.planKey}" is not in the catalogue. ` +
        'Add it to DEMO_PLANS in demo-dataset.ts.',
    );
  }

  const periodStart = startOfCurrentMonth();
  const periodEnd = startOfNextMonth();

  await tx.subscription.create({
    data: {
      id: DEMO_SUBSCRIPTION_IDS[tenant.slug],
      tenantId,
      planId: plan.id,
      status: tenant.subscription.status,
      seats: tenant.subscription.seats,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      // No `provider_customer_id` and no `provider_subscription_id`: those are
      // Polar's to issue (TAR-37), and a made-up one here would look like a
      // real link to a provider account that does not exist.
    },
  });

  await tx.usageCounter.createMany({
    data: tenant.usageCounters.map((counter) => ({
      ...counter,
      tenantId,
      periodStart,
      periodEnd,
    })),
  });
}

/**
 * Deletes the demo tenants so the seed can be re-run.
 *
 * By slug and only these slugs. Every tenant-scoped table cascades from
 * `tenants`, so this one statement takes the whole dataset with it and stays
 * correct as the schema grows — the same reasoning the integration fixtures use.
 *
 * `SystemPrisma`, necessarily: `tenants` carries no RLS policy and `TenantPrisma`
 * refuses to write it at all.
 */
async function resetDemoTenants(
  systemPrisma: PrismaClient,
  slugs: readonly string[],
): Promise<void> {
  const { count } = await systemPrisma.tenant.deleteMany({ where: { slug: { in: [...slugs] } } });

  if (count > 0) {
    console.log(`Removed ${count} existing demo tenant(s) and everything cascading from them.`);
  }
}

/**
 * The plan catalogue. Upserted by `key` rather than deleted and rewritten: it is
 * shared platform data, and a `subscriptions` row belonging to a tenant this
 * seed does not own may already reference it.
 */
async function upsertPlans(systemPrisma: PrismaClient): Promise<void> {
  for (const plan of DEMO_PLANS) {
    await systemPrisma.plan.upsert({
      where: { key: plan.key },
      // `id` and `key` are deliberately absent from the update: an existing plan
      // keeps the id that whatever already points at it was written against,
      // and `key` is what the row was found by.
      update: {
        name: plan.name,
        priceMinorUnits: plan.priceMinorUnits,
        currency: plan.currency,
        interval: plan.interval,
        entitlements: plan.entitlements,
        isActive: plan.isActive,
      },
      create: plan,
    });
  }

  console.log(`Plan catalogue: ${DEMO_PLANS.length} plan(s).`);
}

/**
 * Reads the seeded data back the way the application reads it, and asserts the
 * one property the writes above cannot assert about themselves.
 *
 * Not a formality. Everything so far ran as `whatsappcrm_app` with the GUC set,
 * so the *writes* are already evidence that the grants and the `WITH CHECK` half
 * of each policy work. What is still unproven is the `USING` half: that with one
 * tenant in scope the rows of the other are gone. A seed is the first time two
 * populated tenants exist on a developer's machine, so it is also the cheapest
 * place to check.
 */
async function verify(
  tenantPrisma: TenantPrisma,
  tenantContext: TenantContextService,
  dataset: readonly DemoTenant[],
  tenantIds: ReadonlyMap<string, string>,
): Promise<void> {
  for (const tenant of dataset) {
    const tenantId = tenantIds.get(tenant.slug);

    if (tenantId === undefined) {
      throw new Error(`unreachable: ${tenant.slug} was provisioned in the loop above`);
    }

    await tenantContext.run({ requestId: REQUEST_ID, tenantId, userId: null }, async () => {
      const [users, conversations, messages] = await Promise.all([
        tenantPrisma.user.count(),
        tenantPrisma.conversation.count(),
        tenantPrisma.message.count(),
      ]);

      // Counts, not a sample: seeing the tenant's own rows and seeing *only*
      // them are different claims, and totals across the whole table under RLS
      // are what distinguishes the two.
      expectRowCount(users, tenant.slug, 'users', tenant.users.length);
      expectRowCount(conversations, tenant.slug, 'conversations', tenant.conversations.length);
      expectRowCount(messages, tenant.slug, 'messages', tenant.messages.length);
    });
  }

  console.log('Tenant isolation: each tenant sees its own rows and none of the other tenant’s.');
}

function expectRowCount(actual: number, slug: string, table: string, wanted: number): void {
  if (actual !== wanted) {
    fail(
      `Read back ${actual} row(s) from ${table} with tenant ${slug} in scope, expected ${wanted}.\n` +
        'Either the seed wrote rows under the wrong tenant, or a row-level security policy is missing. ' +
        'Run `pnpm db:verify:rls`.',
    );
  }
}

function report(summaries: readonly SeededTenantSummary[]): void {
  console.log('');

  for (const summary of summaries) {
    console.log(
      `  ${summary.slug.padEnd(10)} http://${summary.hostname}  ` +
        [
          plural(summary.users, 'user'),
          plural(summary.conversations, 'conversation'),
          plural(summary.messages, 'message'),
          plural(summary.tickets, 'ticket'),
        ].join(', '),
    );
  }

  console.log('');
  console.log('Seeded. Sign-in is TAR-35; until then set AUTH_STUB_ENABLED=true to browse as a');
  console.log('seeded user, and reach a tenant on the hostname above (*.localhost needs no');
  console.log('hosts entry in Chrome, Firefox or Safari).');
}

/** Every noun in the summary is regular, so one `s` is the whole rule. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The subscription period. Anchored to the current month so the seeded usage
 * counters land in the period a report run today would ask for; the *rule* is
 * still "the subscription's own period", and TAR-37 replaces this with what the
 * provider says.
 */
function startOfCurrentMonth(): Date {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfNextMonth(): Date {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Host and database, never the credentials. `URL` parsing rather than a regex
 * because a password containing an `@` is legal and would defeat one.
 */
function describeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);

    return `${url.hostname}:${url.port || '5432'}${url.pathname} as ${url.username}`;
  } catch {
    return 'the configured database';
  }
}

function loadRepositoryEnv(): void {
  if (existsSync(ROOT_ENV)) {
    // Leaves already-set variables alone, so `APP_DATABASE_URL=... pnpm db:seed`
    // overrides the file rather than fighting it.
    process.loadEnvFile(ROOT_ENV);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    fail(
      `${name} is not set.\n` +
        'Copy .env.example to .env, then run pnpm db:up, pnpm db:migrate:deploy, pnpm db:roles and pnpm db:roles:login.',
    );
  }

  return value;
}

/** `never` so the callers above narrow correctly after calling it. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error('\nSeeding failed. Nothing was left half-written: each tenant is one transaction.');
  console.error(error);
  process.exit(1);
});
