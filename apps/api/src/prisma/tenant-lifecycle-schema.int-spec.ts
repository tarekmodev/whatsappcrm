import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-403, extended by TAR-413's follow-up: the parts of the tenant-lifecycle
 * schema that `schema.prisma` cannot express, against a real PostgreSQL.
 *
 * The columns and the two new tables are ordinary Prisma and `migrate diff` will
 * report drift on them loudly. These will not report anything:
 *
 *   1. `tenants_deleted_at_matches_status` and the three other CHECKs. Prisma's
 *      schema language has no syntax for one and its describer ignores them, so
 *      a dropped constraint is invisible to every tool in the repository.
 *   2. `tenants_grace_period_ends_at_idx` / `tenants_purge_at_idx` — **partial**.
 *      Prisma's describer skips predicated indexes, so a `migrate dev` that
 *      recreates one without its `WHERE` turns a handful of index entries into
 *      one per tenant and nothing fails.
 *   3. The `lifecycle_events_append_only` trigger, which is the only thing
 *      that stops the table this story exists for being editable by the role
 *      that runs migrations.
 *   4. `app-roles.sql` withholding `UPDATE`/`DELETE` on that table from the
 *      system role and **everything** from the app role — a bootstrap file, not
 *      a migration, so nothing re-asserts it on deploy except the operator
 *      remembering to re-run it. Since ADR 0009 Amendment 1 ruling 2 dropped the
 *      `tenant_isolation` policy, that absent app grant is the only thing
 *      keeping one tenant's lifecycle history away from another's connection.
 *   5. `assert_tenant_active`'s allow-list, and `assert_tenant_serviceable`'s.
 *      Losing `trialing` from the first locks out every tenant self-signup
 *      creates; losing `suspended` from the second silently stops storing a
 *      suspended tenant's inbound WhatsApp messages. No type or schema check can
 *      see the body of a plpgsql function.
 *   6. The narrowed `lifecycle_events_append_only` trigger — the exception for
 *      `notified_at` is expressed as a row comparison inside the function, so a
 *      version that permitted any UPDATE touching that column would look
 *      identical to every tool in the repository.
 *   7. `app-roles.sql`'s **column-level** `GRANT UPDATE ("notified_at")`. Widened
 *      to the table by hand, the audit trail becomes editable by SystemPrisma and
 *      nothing else fails.
 *   8. `lifecycle_events_notified_at_pending_idx` — partial *and* keyed on a
 *      different column from its predicate, neither of which Prisma can express
 *      or describe.
 *
 * Each is asserted twice where a behavioural half exists: once on the catalogue
 * definition, so a narrowed predicate is caught by name, and once behaviourally,
 * so a definition that no longer means what it says still fails.
 * `assignment-workload-schema.int-spec.ts` is the worked example this follows.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and `tar403-fixture` slugs, deleted before the run as well
 * as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '40333333-3333-7333-8333-333333333301';
/**
 * A second, genuinely active tenant. It has to exist rather than be a made-up
 * id: TAR-51's deactivation gate refuses an unknown tenant before RLS is ever
 * consulted, so reading as a fictional one would pass the isolation case
 * without testing isolation.
 */
const OTHER_TENANT = '40333333-3333-7333-8333-333333333302';
const AGENT = '40333333-3333-7333-8333-3333333333b0';

const REQUEST_ID = 'tar403-int-spec';

/** Asserts a single row and hands it back — `noUncheckedIndexedAccess` is on. */
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);

  const [row] = rows;

  if (row === undefined) {
    throw new Error('unreachable: the length assertion above would have failed first');
  }

  return row;
}

describe('tenant lifecycle schema', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  /**
   * The migration owner — `DATABASE_URL`, the role `prisma migrate deploy`
   * connects as. Present only so the append-only trigger can be tested against
   * the one credential the grants do not bind.
   */
  let ownerPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  function indexDefinition(name: string): Promise<{ indexdef: string }[]> {
    return systemPrisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}
    `;
  }

  function checkDefinition(name: string): Promise<{ definition: string }[]> {
    return systemPrisma.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE contype = 'c' AND conname = ${name}
    `;
  }

  /**
   * Raw, because the point of every case below is a row the Prisma client's own
   * types would refuse to construct.
   */
  function insertTransition(
    tenantId: string,
    from: string | null,
    to: string,
    actorType = 'system',
    actorUserId: string | null = null,
    actorLabel: string | null = null,
    trigger = 'system',
  ): Promise<unknown> {
    return systemPrisma.$executeRaw`
      INSERT INTO lifecycle_events (id, tenant_id, actor_type, actor_user_id, actor_label,
                                       from_state, to_state, "trigger")
      VALUES (gen_random_uuid(), ${tenantId}::uuid,
              ${actorType}::audit_actor_type,
              ${actorUserId}::uuid,
              ${actorLabel},
              ${from}::tenant_status,
              ${to}::tenant_status,
              ${trigger}::lifecycle_trigger)
    `;
  }

  function setStatus(tenantId: string, status: string, deletedAt: Date | null): Promise<unknown> {
    return systemPrisma.$executeRaw`
      UPDATE tenants
         SET status = ${status}::tenant_status, deleted_at = ${deletedAt}::timestamptz
       WHERE id = ${tenantId}::uuid
    `;
  }

  async function removeFixture(): Promise<void> {
    // Everything else cascades from the tenant, so one delete covers it and
    // stays correct as the schema grows.
    await systemPrisma.tenant.deleteMany({
      where: { slug: { startsWith: 'tar403-' } },
    });

    // `lifecycle_events` does not, and that is ADR 0009 Amendment 1 ruling 2
    // working as intended: the trail has no foreign key to `tenants`, so it
    // survives the tenant it describes. Neither application role holds DELETE
    // either, so this runs as the migration owner — the same credential the
    // append-only trigger exists to constrain.
    //
    // Without it the fixture ids, which are fixed, accumulate a run's worth of
    // rows every time and the counts below drift on the second execution.
    await ownerPrisma.$executeRaw`
      DELETE FROM lifecycle_events WHERE tenant_id IN (${TENANT}::uuid, ${OTHER_TENANT}::uuid)
    `;
  }

  /**
   * Re-made from scratch before every case rather than cleaned in place, and
   * that is this story's own doing: `lifecycle_events` grants no `DELETE` to
   * either application role, so `systemPrisma` — the widest credential the
   * application has — cannot clear the rows a case wrote. `removeFixture` above
   * reaches for the migration owner instead, which is the only route left.
   */
  async function createFixture(): Promise<void> {
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT, slug: 'tar403-fixture', name: 'TAR-403 fixture', status: 'active' },
        { id: OTHER_TENANT, slug: 'tar403-fixture-b', name: 'TAR-403 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.user.create({
      data: {
        id: AGENT,
        tenantId: TENANT,
        email: 'tar403-agent@fixture.test',
        name: 'TAR-403 agent',
        role: 'admin',
        status: 'active',
      },
    });
  }

  beforeAll(() => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    ownerPrisma = createPrismaClient('system', requireEnv('DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([
      systemPrisma.$disconnect(),
      ownerPrisma.$disconnect(),
      tenantBase.$disconnect(),
    ]);
  });

  beforeEach(async () => {
    await removeFixture();
    await createFixture();
  });

  describe('the tenant status vocabulary', () => {
    it('carries every state the published lifecycle names, plus `created`', async () => {
      const labels = await systemPrisma.$queryRaw<{ enumlabel: string }[]>`
        SELECT e.enumlabel
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'tenant_status'
         ORDER BY e.enumsortorder
      `;

      // Order is the catalogue's, not a preference: `ADD VALUE` appends, and
      // `schema.prisma` lists them this way so `migrate diff` sees no change.
      expect(labels.map((label) => label.enumlabel)).toEqual([
        'created',
        'active',
        'suspended',
        'cancelled',
        'trialing',
        'past_due',
        'deleted',
      ]);
    });

    it('no longer carries `pending`, which `created` renamed', async () => {
      // A leftover `pending` would mean the rename ran as an ADD and there are
      // now two labels for one state — the drift this story closed, reopened.
      const rows = await systemPrisma.$queryRaw<{ enumlabel: string }[]>`
        SELECT e.enumlabel
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'tenant_status' AND e.enumlabel = 'pending'
      `;

      expect(rows).toHaveLength(0);
    });
  });

  describe('`deleted` and `deleted_at` cannot disagree', () => {
    it('is enforced by a CHECK in both directions', async () => {
      const check = only(await checkDefinition('tenants_deleted_at_matches_status'));

      expect(check.definition).toContain("status = 'deleted'");
      expect(check.definition).toContain('deleted_at IS NOT NULL');
    });

    it('refuses a tenant reported as deleted with no purge timestamp', async () => {
      await expect(setStatus(TENANT, 'deleted', null)).rejects.toThrow();
    });

    it('refuses a purge timestamp on a tenant that is not deleted', async () => {
      // The direction that matters: without it a reactivation could quietly
      // resurrect a tenant whose data was already purged.
      await expect(setStatus(TENANT, 'active', new Date())).rejects.toThrow();
    });

    it('accepts the pair set together', async () => {
      await setStatus(TENANT, 'deleted', new Date());

      const tenant = await systemPrisma.tenant.findUniqueOrThrow({
        where: { id: TENANT },
        select: { status: true, deletedAt: true },
      });

      expect(tenant.status).toBe('deleted');
      expect(tenant.deletedAt).not.toBeNull();
    });
  });

  describe('the retention sweeper indexes', () => {
    it.each([
      ['tenants_grace_due', 'grace_period_ends_at', "status = ANY (ARRAY['past_due'"],
      ['tenants_purge_due', 'purge_at', "status = 'suspended'"],
    ])('%s is partial on %s and on the status the sweep scans', async (name, column, predicate) => {
      const index = only(await indexDefinition(name));

      expect(index.indexdef).toContain(`(${column})`);
      // Losing either half of the predicate breaks nothing that fails — see the
      // header. Narrowing it to the status is ADR 0009 Amendment 1's phase 2a′,
      // and it is what obliges TAR-404's sweep to state the status alongside the
      // timer: a partial index the query does not restate is one the planner
      // cannot use.
      expect(index.indexdef).toContain(`${column} IS NOT NULL`);
      expect(index.indexdef).toContain(predicate);
    });

    it('finds a tenant whose grace period has expired and skips the ones with no timer', async () => {
      await systemPrisma.tenant.update({
        where: { id: TENANT },
        data: { gracePeriodEndsAt: new Date(Date.now() - 60_000) },
      });

      const due = await systemPrisma.tenant.findMany({
        where: { gracePeriodEndsAt: { lte: new Date() } },
        select: { id: true },
      });

      expect(due.map((tenant) => tenant.id)).toContain(TENANT);
      expect(due.map((tenant) => tenant.id)).not.toContain(OTHER_TENANT);
    });
  });

  describe('the lifecycle audit trail is append-only', () => {
    it('refuses an UPDATE from the widest credential the application holds', async () => {
      await insertTransition(TENANT, 'active', 'suspended');

      // `whatsappcrm_system` is unrestricted everywhere else in the schema. Here
      // it is stopped by the grant, before the trigger is ever reached.
      await expect(
        systemPrisma.$executeRaw`UPDATE lifecycle_events SET reason = 'tampered' WHERE tenant_id = ${TENANT}::uuid`,
      ).rejects.toThrow(/permission denied/);
    });

    it('refuses an UPDATE from the owner, which no grant constrains', async () => {
      await insertTransition(TENANT, 'active', 'suspended');

      // The 2 a.m. psql session the trigger exists for: the migration owner is
      // bound by neither the grants above nor, being a superuser on a managed
      // cluster, by row-level security. This is the only thing left between it
      // and an editable audit trail.
      await expect(
        ownerPrisma.$executeRaw`UPDATE lifecycle_events SET reason = 'tampered' WHERE tenant_id = ${TENANT}::uuid`,
      ).rejects.toThrow(/append-only/);
    });

    it('grants the app role nothing at all, and withholds UPDATE and DELETE from the system role', async () => {
      const grants = only(
        await systemPrisma.$queryRaw<
          {
            app_select: boolean;
            app_insert: boolean;
            system_select: boolean;
            system_insert: boolean;
            system_update: boolean;
            system_delete: boolean;
          }[]
        >`
          SELECT
            has_table_privilege('whatsappcrm_app', 'lifecycle_events', 'SELECT') AS app_select,
            has_table_privilege('whatsappcrm_app', 'lifecycle_events', 'INSERT') AS app_insert,
            has_table_privilege('whatsappcrm_system', 'lifecycle_events', 'SELECT') AS system_select,
            has_table_privilege('whatsappcrm_system', 'lifecycle_events', 'INSERT') AS system_insert,
            has_table_privilege('whatsappcrm_system', 'lifecycle_events', 'UPDATE') AS system_update,
            has_table_privilege('whatsappcrm_system', 'lifecycle_events', 'DELETE') AS system_delete
        `,
      );

      // The app role's two `false`s are the half of Amendment 1 ruling 2 that the
      // ruling does not spell out. The table kept `tenant_id` and lost the
      // policy that filtered on it, so any grant here would be every tenant's
      // history readable on the tenant connection.
      expect(grants).toEqual({
        app_select: false,
        app_insert: false,
        system_select: true,
        system_insert: true,
        system_update: false,
        system_delete: false,
      });
    });

    it('survives the deletion of the tenant it describes', async () => {
      // Inverted by Amendment 1 ruling 2, and this is the property the ruling
      // exists for: with the foreign key gone there is no cascade, so a purge —
      // or a fixture teardown — cannot take the trail with it.
      await insertTransition(TENANT, null, 'trialing');

      await systemPrisma.tenant.delete({ where: { id: TENANT } });

      expect(await systemPrisma.lifecycleEvent.count({ where: { tenantId: TENANT } })).toBe(1);
    });

    it('does not block the purge that deletes every user, which is what the FK did', async () => {
      // The reproduction of the defect ruling 2 was decided on. The purge
      // deletes every `users` row and keeps the `tenants` row as the slug
      // tombstone; the shipped composite FK to `users(tenant_id, id)` was
      // `ON DELETE NO ACTION`, so a retained row naming that user raised 23503 —
      // and no repair was possible, because the trigger refuses the UPDATE and
      // neither role holds DELETE.
      //
      // `actor_type = 'user'` is the only actor kind that fills the column, and
      // it is what a tenant admin deleting their own tenant writes.
      await insertTransition(TENANT, 'active', 'cancelled', 'user', AGENT);

      await expect(systemPrisma.user.deleteMany({ where: { tenantId: TENANT } })).resolves.toEqual({
        count: 1,
      });

      const survivor = only(
        await systemPrisma.lifecycleEvent.findMany({
          where: { tenantId: TENANT },
          select: { actorUserId: true },
        }),
      );

      // The identifier is kept, and it now names a user that no longer exists.
      // That is the trade ruling 2 makes deliberately: a trail whose integrity
      // depends on the rows it describes still existing cannot outlive a purge.
      expect(survivor.actorUserId).toBe(AGENT);
    });

    it('refuses a transition that does not change the state', async () => {
      const check = only(await checkDefinition('lifecycle_events_transition_changes_state'));

      expect(check.definition).toContain('from_state IS NULL');

      await expect(insertTransition(TENANT, 'active', 'active')).rejects.toThrow();
    });

    it('allows a null from_state, which is a tenant’s first row', async () => {
      await expect(insertTransition(TENANT, null, 'created')).resolves.not.toThrow();
    });

    it('makes the actor attribution triple agree with itself', async () => {
      const check = only(await checkDefinition('lifecycle_events_actor_attribution'));

      expect(check.definition).toContain('actor_user_id IS NOT NULL');
      expect(check.definition).toContain('actor_label IS NOT NULL');

      // A `user` row with no user, and a `platform_operator` row wearing a user
      // id — the two shapes that would make "who suspended this tenant" answer
      // with something it invented.
      await expect(insertTransition(TENANT, 'active', 'suspended', 'user')).rejects.toThrow();
      await expect(
        insertTransition(TENANT, 'active', 'suspended', 'platform_operator', AGENT, 'ops-key-1'),
      ).rejects.toThrow();

      await expect(
        insertTransition(TENANT, 'active', 'suspended', 'user', AGENT),
      ).resolves.not.toThrow();
    });

    it('is unreachable from the tenant connection, which is what replaced the policy', async () => {
      await insertTransition(TENANT, 'active', 'suspended');
      await insertTransition(OTHER_TENANT, 'active', 'cancelled');

      // Two layers, and the order matters. `tenant-scope.extension.ts` refuses
      // first and names the cause; underneath it the app role holds no grant, so
      // even a call that bypassed the extension gets 42501 rather than another
      // tenant's history. Asserting the extension's message would pass on a
      // database where the grant had been restored by hand, so the raw path is
      // checked too.
      await expect(asTenant(TENANT, () => tenantPrisma.lifecycleEvent.findMany())).rejects.toThrow(
        /system/i,
      );

      await expect(
        asTenant(TENANT, () => tenantPrisma.$queryRaw`SELECT count(*) FROM lifecycle_events`),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('what caused the transition', () => {
    it('publishes exactly the five triggers the contract does', async () => {
      const labels = await systemPrisma.$queryRaw<{ enumlabel: string }[]>`
        SELECT e.enumlabel
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'lifecycle_trigger'
         ORDER BY e.enumsortorder
      `;

      expect(labels.map((label) => label.enumlabel)).toEqual([
        'user_action',
        'operator_action',
        'billing_event',
        'timer',
        'system',
      ]);
    });

    it('has no default, so a writer that forgets the trigger fails instead of guessing', async () => {
      // The whole point of the column. A default would let the engine record
      // `system` by omission for an edge a person caused, which is the drift
      // "no active → past_due from a button" is meant to be assertable against.
      await expect(
        systemPrisma.$executeRaw`
          INSERT INTO lifecycle_events (id, tenant_id, actor_type, from_state, to_state)
          VALUES (gen_random_uuid(), ${TENANT}::uuid, 'system'::audit_actor_type,
                  'active'::tenant_status, 'suspended'::tenant_status)
        `,
      ).rejects.toThrow();
    });

    it('records a trigger independently of the actor', async () => {
      // An operator hand-posting a billing webhook: `platform_operator` acted,
      // and the edge is still a `billing_event`. Either column alone would
      // describe this transition wrongly.
      await insertTransition(
        TENANT,
        'active',
        'past_due',
        'platform_operator',
        null,
        'ops-key-1',
        'billing_event',
      );

      const row = only(
        await systemPrisma.lifecycleEvent.findMany({
          where: { tenantId: TENANT },
          select: { trigger: true, actorType: true },
        }),
      );

      expect(row).toEqual({ trigger: 'billing_event', actorType: 'platform_operator' });
    });
  });

  describe('the notification backstop', () => {
    /** The sweep's own query: everything still owing a notification. */
    function pending(tenantId: string): Promise<{ id: string }[]> {
      return systemPrisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM lifecycle_events
         WHERE notified_at IS NULL AND tenant_id = ${tenantId}::uuid
         ORDER BY occurred_at
      `;
    }

    it('starts null on a new row, which is what the sweep looks for', async () => {
      await insertTransition(TENANT, 'active', 'suspended');

      expect(await pending(TENANT)).toHaveLength(1);
    });

    it('indexes the backlog on occurred_at, partial on the rows that owe one', async () => {
      const index = only(await indexDefinition('lifecycle_events_notified_at_pending_idx'));

      // Keyed on `occurred_at` and not on the predicate column: every row in
      // this index holds NULL there, so indexing it would give the "older than a
      // minute" bound nothing to seek on. Losing either half breaks nothing that
      // fails — see the header.
      expect(index.indexdef).toContain('(occurred_at)');
      expect(index.indexdef).toContain('WHERE (notified_at IS NULL)');
    });

    it('lets the system role stamp it once, from null', async () => {
      await insertTransition(TENANT, 'active', 'suspended');

      await expect(
        systemPrisma.$executeRaw`
          UPDATE lifecycle_events SET notified_at = now()
           WHERE tenant_id = ${TENANT}::uuid AND notified_at IS NULL
        `,
      ).resolves.toBe(1);

      expect(await pending(TENANT)).toHaveLength(0);
    });

    it('refuses a second stamp, a cleared stamp, and a stamp that smuggles another column', async () => {
      await insertTransition(TENANT, 'active', 'suspended');
      await systemPrisma.$executeRaw`
        UPDATE lifecycle_events SET notified_at = now() WHERE tenant_id = ${TENANT}::uuid
      `;

      // One-way: a stamp that could be moved is not a record of when the
      // notification went out.
      await expect(
        systemPrisma.$executeRaw`
          UPDATE lifecycle_events SET notified_at = now() WHERE tenant_id = ${TENANT}::uuid
        `,
      ).rejects.toThrow(/append-only/);

      await expect(
        systemPrisma.$executeRaw`
          UPDATE lifecycle_events SET notified_at = NULL WHERE tenant_id = ${TENANT}::uuid
        `,
      ).rejects.toThrow(/append-only/);

      // The exception is narrowed to *this column*, not to any UPDATE that
      // happens to touch it. Here the grant stops it first — which is the point
      // of keeping the grant column-level rather than table-level.
      await expect(
        systemPrisma.$executeRaw`
          UPDATE lifecycle_events SET notified_at = now(), reason = 'tampered'
           WHERE tenant_id = ${TENANT}::uuid
        `,
      ).rejects.toThrow(/permission denied/);
    });

    it('refuses a stamp that edits another column even from the owner, whom no grant binds', async () => {
      await insertTransition(TENANT, 'active', 'suspended');

      // The 2 a.m. psql session again, this time using the one permitted UPDATE
      // as cover. The trigger compares the two rows rather than trusting the
      // SET list.
      await expect(
        ownerPrisma.$executeRaw`
          UPDATE lifecycle_events SET notified_at = now(), to_state = 'cancelled'::tenant_status
           WHERE tenant_id = ${TENANT}::uuid
        `,
      ).rejects.toThrow(/append-only/);

      await expect(
        ownerPrisma.$executeRaw`
          UPDATE lifecycle_events SET notified_at = now() WHERE tenant_id = ${TENANT}::uuid
        `,
      ).resolves.toBe(1);
    });

    it('grants UPDATE on the one column and still withholds it on the table', async () => {
      const grants = only(
        await systemPrisma.$queryRaw<
          {
            system_table_update: boolean;
            system_notified_at: boolean;
            system_reason: boolean;
            app_notified_at: boolean;
          }[]
        >`
          SELECT
            has_table_privilege('whatsappcrm_system', 'lifecycle_events', 'UPDATE')
              AS system_table_update,
            has_column_privilege('whatsappcrm_system', 'lifecycle_events', 'notified_at', 'UPDATE')
              AS system_notified_at,
            has_column_privilege('whatsappcrm_system', 'lifecycle_events', 'reason', 'UPDATE')
              AS system_reason,
            has_column_privilege('whatsappcrm_app', 'lifecycle_events', 'notified_at', 'UPDATE')
              AS app_notified_at
        `,
      );

      // The tenant role is excluded on purpose: the sweep and the mailer are
      // cross-tenant workers with no request context, so they run on
      // SystemPrisma.
      expect(grants).toEqual({
        system_table_update: false,
        system_notified_at: true,
        system_reason: false,
        app_notified_at: false,
      });
    });
  });

  describe('the tenant entitlements row', () => {
    /** The published trial shape, and the column default (ADR 0009 decision 6). */
    const TRIAL_ENTITLEMENTS = {
      features: ['assignment_rules', 'sla_policies'],
      limits: {
        seats: 3,
        conversationsPerPeriod: 1000,
        whatsappNumbers: 1,
        teams: 2,
        knowledgeDocuments: 10,
      },
    };

    interface Entitlements {
      features: unknown;
      limits: Record<string, unknown>;
    }

    /**
     * Prisma's `InputJsonValue` will not accept an `unknown`, and half these
     * fixtures are deliberately the wrong type — that is what the CHECK is being
     * tested against. The cast crosses that boundary once, here.
     */
    function json(value: Entitlements): Prisma.InputJsonObject {
      return value as unknown as Prisma.InputJsonObject;
    }

    /** Everything unlimited, in the shape the CHECK insists on. */
    function unlimited(features: string[] = []): Entitlements {
      return {
        features,
        limits: {
          seats: null,
          conversationsPerPeriod: null,
          whatsappNumbers: null,
          teams: null,
          knowledgeDocuments: null,
        },
      };
    }

    /** `unlimited()` with one limit replaced — the shape every refusal below varies. */
    function withSeats(seats: unknown): Entitlements {
      const base = unlimited();

      return { ...base, limits: { ...base.limits, seats } };
    }

    it('defaults a new row to the published trial shape', async () => {
      const row = await systemPrisma.tenantEntitlements.create({
        data: { tenantId: TENANT },
        select: { planKey: true, planName: true, entitlements: true },
      });

      // Placeholder values, not measured ones. TAR-397 fixes the real figures,
      // and this pins them so the change is a decision rather than a drift.
      expect(row).toEqual({
        planKey: 'trial',
        planName: 'Trial',
        entitlements: TRIAL_ENTITLEMENTS,
      });
    });

    it('holds at most one row per tenant', async () => {
      await systemPrisma.tenantEntitlements.create({ data: { tenantId: TENANT } });

      await expect(
        systemPrisma.tenantEntitlements.create({ data: { tenantId: TENANT } }),
      ).rejects.toThrow();
    });

    it('carries all five limits, so the response maps from one row with no join', async () => {
      const row = await systemPrisma.tenantEntitlements.create({
        data: { tenantId: TENANT },
        select: { entitlements: true },
      });

      // The reason ruling 3 widened the table: `TenantLifecycleResponse.plan`
      // publishes `PlanEntitlements`, and two of five limits could not populate
      // it. Named individually so dropping one fails here rather than at render.
      expect(Object.keys((row.entitlements as { limits: object }).limits).sort()).toEqual([
        'conversationsPerPeriod',
        'knowledgeDocuments',
        'seats',
        'teams',
        'whatsappNumbers',
      ]);
    });

    it('spells unlimited as null and refuses a limit of zero', async () => {
      const check = only(await checkDefinition('tenant_entitlements_shape'));

      expect(check.definition).toContain('seats');
      expect(check.definition).toContain('knowledgeDocuments');

      const row = await systemPrisma.tenantEntitlements.create({
        data: {
          tenantId: TENANT,
          planKey: 'unlimited',
          planName: 'Unlimited',
          entitlements: json(unlimited()),
        },
        select: { entitlements: true },
      });

      expect(row.entitlements).toEqual(unlimited());

      // Zero is a lockout reached by arithmetic rather than a limit anyone
      // decided — what `tenant_plan_limits_caps_positive` used to say, now said
      // about a jsonb key.
      await expect(
        systemPrisma.tenantEntitlements.create({
          data: { tenantId: OTHER_TENANT, entitlements: json(withSeats(0)) },
        }),
      ).rejects.toThrow();
    });

    it.each([
      // The one a NULL-tolerant CHECK would wave through: a missing key makes
      // `jsonb_typeof` return SQL NULL, and a CHECK that evaluates to NULL
      // passes. `jsonb_exists` before each type test is what closes it.
      ['a missing limit', { features: [], limits: { seats: 3 } }],
      ['a negative limit', withSeats(-1)],
      ['a fractional limit', withSeats(2.5)],
      // Refused rather than raising 22P02, which is why the check is a regex on
      // the text form and not a cast.
      ['a limit that is not a number', withSeats('three')],
      ['a limit in exponent notation', withSeats('1e3')],
      ['features that are not an array', { features: {}, limits: unlimited().limits }],
    ])('refuses %s', async (_name, entitlements) => {
      await expect(
        systemPrisma.tenantEntitlements.create({
          data: { tenantId: TENANT, entitlements: json(entitlements) },
        }),
      ).rejects.toThrow();
    });

    it('refuses a plan key the catalogue could not hold', async () => {
      await expect(
        systemPrisma.tenantEntitlements.create({
          data: { tenantId: TENANT, planKey: 'Trial Plan' },
        }),
      ).rejects.toThrow();
    });

    it('is readable on the tenant connection, which is where enforcement runs', async () => {
      await systemPrisma.tenantEntitlements.create({ data: { tenantId: TENANT } });
      await systemPrisma.tenantEntitlements.create({
        data: { tenantId: OTHER_TENANT, entitlements: json(withSeats(99)) },
      });

      // Still RLS-scoped, unlike `lifecycle_events`: enforcement and display
      // both read this row on the tenant connection, which is ruling 3's point.
      const mine = await asTenant(TENANT, () => tenantPrisma.tenantEntitlements.findMany());

      expect(mine).toHaveLength(1);
      expect((only(mine).entitlements as { limits: { seats: number } }).limits.seats).toBe(3);
    });
  });

  describe('the deactivation gate', () => {
    it.each([
      ['created', false],
      ['trialing', true],
      ['active', true],
      ['past_due', true],
      ['suspended', false],
      ['cancelled', false],
    ])('%s is admitted: %s', async (status, admitted) => {
      await setStatus(TENANT, status, null);

      const read = asTenant(TENANT, () => tenantPrisma.contact.findMany());

      if (admitted) {
        // `trialing` is the one that matters most: it is the state every tenant
        // self-signup creates, and a gate that refused it would make the whole
        // signup flow answer 403 on its first request.
        await expect(read).resolves.toEqual([]);
      } else {
        await expect(read).rejects.toThrow();
      }
    });

    it('refuses a purged tenant', async () => {
      await setStatus(TENANT, 'deleted', new Date());

      await expect(asTenant(TENANT, () => tenantPrisma.contact.findMany())).rejects.toThrow();
    });
  });

  describe('a purge can say it started', () => {
    it('resumes rather than restarting, and is distinguishable from a queued purge', async () => {
      const startedAt = new Date(Date.now() - 30_000);

      await systemPrisma.tenant.update({
        where: { id: TENANT },
        data: {
          status: 'suspended',
          purgeAt: new Date(Date.now() - 60_000),
          purgeStartedAt: startedAt,
        },
      });
      await systemPrisma.tenant.update({
        where: { id: OTHER_TENANT },
        data: { status: 'suspended', purgeAt: new Date(Date.now() - 60_000) },
      });

      // Both are due. Without this column they are the same row to the sweep,
      // and the crashed one restarts from its first batch on every pass.
      const inFlight = await systemPrisma.tenant.findMany({
        where: {
          slug: { startsWith: 'tar403-' },
          purgeAt: { lte: new Date() },
          purgeStartedAt: { not: null },
        },
        select: { id: true },
      });

      expect(inFlight.map((tenant) => tenant.id)).toEqual([TENANT]);
    });
  });

  describe('the serviceable gate (ADR 0009 decision 2, as amended by ruling 1)', () => {
    /**
     * Called directly rather than through `TenantPrisma`, because this is phase
     * 1 of an expand → migrate → contract rename: the function exists and has no
     * callers until TAR-404's engine PR moves `tenant-scope.extension.ts` onto
     * it. Asserting it here is what makes that move a one-line change with the
     * behaviour already proven.
     */
    function serviceable(tenantId: string): Promise<unknown> {
      return systemPrisma.$queryRaw`SELECT public.assert_tenant_serviceable(${tenantId})`;
    }

    it.each([
      ['created', false],
      ['trialing', true],
      ['active', true],
      ['past_due', true],
      ['suspended', true],
      ['cancelled', true],
    ])('%s is serviceable: %s', async (status, admitted) => {
      await setStatus(TENANT, status, null);

      if (admitted) {
        // Two of these carry the ruling. `suspended`: inbound WhatsApp messages
        // are written through TenantPrisma under RLS, so refusing it makes Meta
        // retry and then drop real customer messages. `cancelled`: the recovery
        // allowlist that undoes a cancellation reads through TenantPrisma in
        // `auth.service.ts` and `session.service.ts`, so refusing it makes the
        // seven-day undo window unreachable. Refusing the *principal* is
        // TenantStatusGuard's job, one layer up.
        await expect(serviceable(TENANT)).resolves.toBeDefined();
      } else {
        await expect(serviceable(TENANT)).rejects.toThrow(/TENANT_NOT_SERVICEABLE/);
      }
    });

    it('refuses exactly two states, and they are the two where the data is not there', async () => {
      // Stated as its own case because it is the invariant ruling 1 asks to be
      // kept: `created` (provisioning unfinished) and `deleted` (a tombstone).
      // Any third refusal means per-state access control has leaked back into
      // the gate that cannot hold it.
      const refused: string[] = [];

      for (const status of [
        'created',
        'trialing',
        'active',
        'past_due',
        'suspended',
        'cancelled',
      ]) {
        await setStatus(TENANT, status, null);
        await serviceable(TENANT).catch(() => refused.push(status));
      }

      await setStatus(TENANT, 'deleted', new Date());
      await serviceable(TENANT).catch(() => refused.push('deleted'));

      expect(refused).toEqual(['created', 'deleted']);
    });

    it('still refuses a purged tenant, an unknown id and a non-uuid', async () => {
      await setStatus(TENANT, 'deleted', new Date());

      await expect(serviceable(TENANT)).rejects.toThrow(/TENANT_NOT_SERVICEABLE/);
      await expect(serviceable('40333333-3333-7333-8333-3333333339ff')).rejects.toThrow(
        /does not exist/,
      );
      await expect(serviceable('not-a-uuid')).rejects.toThrow(/is not a uuid/);
    });

    it('leaves the old gate alone, so nothing changes until the call site moves', async () => {
      await setStatus(TENANT, 'suspended', null);

      // The two coexist on purpose. Applying the migration is inert; the
      // behaviour changes in the deploy that switches TenantPrisma over, and
      // that deploy is revertible on its own.
      await expect(
        systemPrisma.$queryRaw`SELECT public.assert_tenant_active(${TENANT})`,
      ).rejects.toThrow(/TENANT_NOT_ACTIVE/);
      await expect(asTenant(TENANT, () => tenantPrisma.contact.findMany())).rejects.toThrow();
    });
  });
});

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
