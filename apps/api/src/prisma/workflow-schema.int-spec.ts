import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-394: the parts of the workflow schema that `schema.prisma` cannot express,
 * against a real PostgreSQL.
 *
 * Everything else in `20260816130000_notifications_generalisation` and
 * `20260816140000_workflow_rule_schema` is an ordinary column or index and Prisma
 * will tell you loudly if it drifts. These seven will not tell you anything:
 *
 *   1. **`workflow_references_scope_key` is `NULLS NOT DISTINCT`.** The worst of
 *      the seven. Every row in that table carries exactly two NULLs in the key, so
 *      without those three words the index constrains *nothing* — the duplicate it
 *      exists to prevent inserts cleanly. Prisma matches `@@unique` against the
 *      index either way and reports no drift, so a `migrate dev` that recreates it
 *      for an unrelated reason recreates it NULL-distinct. Same trap as
 *      `assignment_state_tenant_scope_key` (TAR-272).
 *   2. **The tag and team foreign keys are `NO ACTION`, not `RESTRICT`.** ADR 0009
 *      specifies `RESTRICT`; this schema's convention 4 forbids it. The difference
 *      is invisible until a tenant is deleted: `RESTRICT` is checked the instant
 *      the tag row goes, so the cascade from `tenants` would abort depending on the
 *      order Postgres picked, and the failure would land on TAR-403's purge and on
 *      every fixture in this repository. Asserted in both directions here, because
 *      a well-meaning "tighten this to RESTRICT" is exactly the review comment that
 *      looks correct.
 *   3. `workflow_references_one_target` — a CHECK. Prisma's schema language has
 *      none, and its describer ignores them.
 *   4. `workflows_broken_is_inactive` — likewise.
 *   5. `workflow_runs_results_is_array` and
 *      `workflow_runs_failure_reason_only_when_failed` — likewise.
 *   6. `notifications_sla_breach_columns` — likewise, and it is the invariant that
 *      lets `GET /api/v1/sla-alerts` keep publishing a non-null `dueAt` from a
 *      column that is now nullable.
 *   7. `tickets_active_created_at_idx` — partial. Prisma's describer skips indexes
 *      carrying a predicate, so `migrate dev` proposes neither to create nor to
 *      drop it, and the elapsed sweep would lose its access path silently.
 *
 * The exactly-once claim is asserted too, even though `@@unique` does express it:
 * it is the entire mechanism behind "one escalation, not one per sweep tick"
 * (0009, decision 2), and the failure mode is a supervisor's pager rather than an
 * error anybody sees.
 *
 * Each object is asserted twice over where it can be: once on its catalogue
 * definition, so a narrowed predicate or a dropped `NULLS NOT DISTINCT` is caught
 * by name, and once behaviourally, so an assertion that passes against a
 * definition which no longer means what it says still fails.
 * `assignment-workload-schema.int-spec.ts` is the worked example this follows.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Three fixture tenants
 * carrying fixed ids and `tar394-fixture` slugs, deleted before the run as well as
 * after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '39422222-2222-7222-8222-222222222201';
/**
 * A second, genuinely active tenant. It has to exist rather than be a made-up id:
 * TAR-51's deactivation gate refuses an unknown tenant before RLS is ever
 * consulted, so reading as a fictional one would pass the isolation case without
 * testing isolation.
 */
const OTHER_TENANT = '39422222-2222-7222-8222-222222222202';
/** Deleted by one case on purpose — the tenant-cascade half of assertion 2. */
const DOOMED_TENANT = '39422222-2222-7222-8222-222222222203';

const TEAM = '39422222-2222-7222-8222-2222222222a0';
const AGENT = '39422222-2222-7222-8222-2222222222b0';
const CONTACT = '39422222-2222-7222-8222-2222222222c0';
const TAG = '39422222-2222-7222-8222-2222222222d0';
const OTHER_TAG = '39422222-2222-7222-8222-2222222222d1';

const REQUEST_ID = 'tar394-int-spec';

/** Asserts a single row and hands it back — `noUncheckedIndexedAccess` is on. */
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);

  const [row] = rows;

  if (row === undefined) {
    throw new Error('unreachable: the length assertion above would have failed first');
  }

  return row;
}

describe('workflow schema', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  /** Next free ticket number, so cases can be added without renumbering. */
  let nextNumber = 39_400;
  let ticketId = '';

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

  /** `confdeltype` is 'a' for NO ACTION, 'r' for RESTRICT, 'c' for CASCADE. */
  function foreignKeyDeleteAction(name: string): Promise<{ confdeltype: string }[]> {
    return systemPrisma.$queryRaw<{ confdeltype: string }[]>`
      SELECT confdeltype::text FROM pg_constraint WHERE contype = 'f' AND conname = ${name}
    `;
  }

  async function createWorkflow(
    id: string,
    tenantId: string,
    name: string,
    isActive = false,
  ): Promise<void> {
    await systemPrisma.workflow.create({
      data: {
        id,
        tenantId,
        name,
        isActive,
        position: 0,
        triggerType: 'ticket_unresolved_for',
        definition: {
          trigger: { type: 'ticket_unresolved_for', minutes: 240 },
          conditions: [],
          actions: [{ type: 'add_ticket_tag', tagId: TAG }],
        },
      },
    });
  }

  /**
   * Raw, because several cases have to write shapes the Prisma client would refuse
   * to construct — a run with two non-null targets, a `results` object rather than
   * an array. That is the point of the CHECKs.
   */
  function insertReference(
    workflowId: string,
    tenantId: string,
    columns: { tagId?: string | null; teamId?: string | null; userId?: string | null },
  ): Promise<unknown> {
    return systemPrisma.$executeRaw`
      INSERT INTO workflow_references (id, tenant_id, workflow_id, tag_id, team_id, user_id, created_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${workflowId}::uuid,
              ${columns.tagId ?? null}::uuid, ${columns.teamId ?? null}::uuid,
              ${columns.userId ?? null}::uuid, now())
    `;
  }

  function insertRun(
    workflowId: string,
    dedupeKey: string,
    overrides: { status?: string; results?: string; failureReason?: string | null } = {},
  ): Promise<unknown> {
    const { status = 'succeeded', results = '[]', failureReason = null } = overrides;

    return systemPrisma.$executeRaw`
      INSERT INTO workflow_runs (id, tenant_id, workflow_id, ticket_id, workflow_version,
                                 dedupe_key, status, results, failure_reason, created_at)
      VALUES (gen_random_uuid(), ${TENANT}::uuid, ${workflowId}::uuid, ${ticketId}::uuid, 1,
              ${dedupeKey}, ${status}::workflow_run_status, ${results}::jsonb,
              ${failureReason}::workflow_failure_reason, now())
    `;
  }

  async function removeFixture(): Promise<void> {
    // Everything below cascades from the tenant, so one delete is enough and stays
    // correct as the schema grows — and that it *is* enough with reference rows
    // present is itself one of the properties this file asserts.
    await systemPrisma.tenant.deleteMany({
      where: { id: { in: [TENANT, OTHER_TENANT, DOOMED_TENANT] } },
    });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT, slug: 'tar394-fixture', name: 'TAR-394 fixture', status: 'active' },
        { id: OTHER_TENANT, slug: 'tar394-fixture-b', name: 'TAR-394 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.team.create({
      data: { id: TEAM, tenantId: TENANT, name: 'TAR-394 escalations' },
    });
    await systemPrisma.user.create({
      data: {
        id: AGENT,
        tenantId: TENANT,
        email: 'tar394-agent@fixture.test',
        name: 'TAR-394 agent',
        role: 'supervisor',
        status: 'active',
      },
    });
    await systemPrisma.contact.create({
      data: { id: CONTACT, tenantId: TENANT, phoneE164: '+10000039401' },
    });
    await systemPrisma.tag.createMany({
      data: [
        { id: TAG, tenantId: TENANT, name: 'escalated' },
        { id: OTHER_TAG, tenantId: TENANT, name: 'vip' },
      ],
    });

    const ticket = await systemPrisma.ticket.create({
      data: { tenantId: TENANT, number: (nextNumber += 1), contactId: CONTACT },
      select: { id: true },
    });

    ticketId = ticket.id;
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    // Reference rows and runs cascade from the workflow, so one delete clears the
    // three tables every case writes to.
    await systemPrisma.workflow.deleteMany({ where: { tenantId: { in: [TENANT, OTHER_TENANT] } } });
    await systemPrisma.ticketTag.deleteMany({ where: { tenantId: TENANT } });
    await systemPrisma.notification.deleteMany({ where: { tenantId: TENANT } });
  });

  describe('a workflow references an entity at most once', () => {
    const WORKFLOW = '39422222-2222-7222-8222-2222222222e0';

    it('is unique NULLS NOT DISTINCT, not merely unique', async () => {
      const index = only(await indexDefinition('workflow_references_scope_key'));

      expect(index.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(index.indexdef).toContain('(tenant_id, workflow_id, tag_id, team_id, user_id)');
      // The assertion this whole file exists for. Dropping these three words
      // breaks nothing that fails — see the header.
      expect(index.indexdef).toContain('NULLS NOT DISTINCT');
    });

    it('refuses a second row for the same workflow and tag', async () => {
      await createWorkflow(WORKFLOW, TENANT, 'Escalate stale tickets');
      await insertReference(WORKFLOW, TENANT, { tagId: TAG });

      // Behavioural half of the case above. Without `NULLS NOT DISTINCT` this
      // insert succeeds, nothing reports an error, and "3 workflows use this tag"
      // starts counting rows instead of workflows.
      await expect(insertReference(WORKFLOW, TENANT, { tagId: TAG })).rejects.toThrow(
        /workflow_references_scope_key/,
      );
    });

    it('still admits the same workflow referencing a second tag, and a team', async () => {
      await createWorkflow(WORKFLOW, TENANT, 'Escalate stale tickets');

      await expect(insertReference(WORKFLOW, TENANT, { tagId: TAG })).resolves.toBeGreaterThan(0);
      await expect(
        insertReference(WORKFLOW, TENANT, { tagId: OTHER_TAG }),
      ).resolves.toBeGreaterThan(0);
      await expect(insertReference(WORKFLOW, TENANT, { teamId: TEAM })).resolves.toBeGreaterThan(0);
    });

    it('names exactly one entity per row', async () => {
      const check = only(await checkDefinition('workflow_references_one_target'));
      expect(check.definition).toContain('num_nonnulls');

      await createWorkflow(WORKFLOW, TENANT, 'Escalate stale tickets');

      // Both asymmetries: a row naming nothing is a reference to nothing, and a row
      // naming two entities makes "which workflows use this tag" ambiguous about
      // what it counted.
      await expect(insertReference(WORKFLOW, TENANT, {})).rejects.toThrow(
        /workflow_references_one_target/,
      );
      await expect(insertReference(WORKFLOW, TENANT, { tagId: TAG, teamId: TEAM })).rejects.toThrow(
        /workflow_references_one_target/,
      );
    });
  });

  describe('a referenced tag cannot be deleted, and a tenant still can', () => {
    const WORKFLOW = '39422222-2222-7222-8222-2222222222e1';

    it.each([
      ['workflow_references_tenant_id_tag_id_fkey'],
      ['workflow_references_tenant_id_team_id_fkey'],
      ['workflow_references_tenant_id_user_id_fkey'],
    ])('%s is NO ACTION rather than RESTRICT', async (name) => {
      const fk = only(await foreignKeyDeleteAction(name));

      // 'a' is NO ACTION, 'r' is RESTRICT. Both refuse the delete of a referenced
      // row; only 'a' defers the check to end of statement, which is what lets the
      // cascade from `tenants` remove the tag and this row together. See the
      // header, assertion 2 — and do not "tighten" this to 'r'.
      expect(fk.confdeltype).toBe('a');
    });

    it('refuses to delete a tag a workflow references', async () => {
      await createWorkflow(WORKFLOW, TENANT, 'Escalate stale tickets');
      await insertReference(WORKFLOW, TENANT, { tagId: TAG });

      // The product requirement: the *database* refuses, so `ContactsModule` needs
      // no upward import into `WorkflowsModule` to enforce it (0009, decision 6).
      // The violation names the constraint, which is what lets the module answer
      // `conflict` and name the workflows rather than surfacing a 500.
      await expect(systemPrisma.tag.delete({ where: { id: TAG } })).rejects.toThrow(
        /workflow_references_tenant_id_tag_id_fkey/,
      );

      // A tag nobody references is still deletable, and comes back for the cases
      // after this one.
      await expect(systemPrisma.tag.delete({ where: { id: OTHER_TAG } })).resolves.toBeDefined();
      await systemPrisma.tag.create({ data: { id: OTHER_TAG, tenantId: TENANT, name: 'vip' } });
    });

    it('lets a whole tenant be deleted with reference rows in place', async () => {
      // The half `RESTRICT` would break. One statement removes the tenant, its
      // tags and its `workflow_references` rows; with NO ACTION the referential
      // check runs after the statement, by which time the referencing rows are
      // gone. With RESTRICT this raises — and takes TAR-403's purge, the seed and
      // every fixture in this repository with it.
      const workflowId = '39422222-2222-7222-8222-2222222222e2';
      const tagId = '39422222-2222-7222-8222-2222222222d2';

      await systemPrisma.tenant.create({
        data: { id: DOOMED_TENANT, slug: 'tar394-fixture-c', name: 'TAR-394 fixture C' },
      });
      await systemPrisma.tag.create({
        data: { id: tagId, tenantId: DOOMED_TENANT, name: 'doomed' },
      });
      await systemPrisma.workflow.create({
        data: {
          id: workflowId,
          tenantId: DOOMED_TENANT,
          name: 'Doomed workflow',
          triggerType: 'ticket_created',
          definition: { trigger: { type: 'ticket_created' }, conditions: [], actions: [] },
        },
      });
      await insertReference(workflowId, DOOMED_TENANT, { tagId });

      await expect(
        systemPrisma.tenant.delete({ where: { id: DOOMED_TENANT } }),
      ).resolves.toBeDefined();
    });
  });

  describe('a broken workflow cannot be active', () => {
    const WORKFLOW = '39422222-2222-7222-8222-2222222222e3';

    it('is enforced by a CHECK', async () => {
      const check = only(await checkDefinition('workflows_broken_is_inactive'));

      expect(check.definition).toContain('broken_reason IS NULL');
      expect(check.definition).toContain('is_active');
    });

    it('refuses to re-enable a workflow whose reference is still broken', async () => {
      await createWorkflow(WORKFLOW, TENANT, 'Escalate stale tickets');

      // The state the user-removal transaction leaves behind (0009, decision 6).
      await systemPrisma.workflow.update({
        where: { id: WORKFLOW },
        data: { isActive: false, brokenReason: 'reference_removed' },
      });

      // "Fix the reference, then enable", made structural. The API answers
      // `validation_failed` and names the field; this is the backstop under
      // anything that writes without going through it.
      await expect(
        systemPrisma.workflow.update({ where: { id: WORKFLOW }, data: { isActive: true } }),
      ).rejects.toThrow(/workflows_broken_is_inactive/);

      // Clearing the reason and enabling in one statement is the fixed case, and it
      // has to keep working.
      await expect(
        systemPrisma.workflow.update({
          where: { id: WORKFLOW },
          data: { isActive: true, brokenReason: null },
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('one occurrence produces one run', () => {
    const WORKFLOW = '39422222-2222-7222-8222-2222222222e4';

    beforeEach(async () => {
      await createWorkflow(WORKFLOW, TENANT, 'Escalate stale tickets', true);
    });

    it('claims a (workflow, dedupe key) pair exactly once', async () => {
      const key = `ticket:${ticketId}`;

      await expect(insertRun(WORKFLOW, key)).resolves.toBeGreaterThan(0);

      // The mechanism, not an optimisation over one: a sweep re-asking every 60
      // seconds, two replicas, and a redelivered job all reach this index. Without
      // it, an overdue ticket escalates once a minute for as long as it stays open.
      await expect(insertRun(WORKFLOW, key)).rejects.toThrow(
        /workflow_runs_tenant_id_workflow_id_dedupe_key_key/,
      );
    });

    it('lets a second workflow claim the same occurrence', async () => {
      const second = '39422222-2222-7222-8222-2222222222e5';
      const key = `ticket:${ticketId}`;

      await createWorkflow(second, TENANT, 'Notify the supervisor', true);

      // Every matching workflow runs — this is not first-match-wins (0009,
      // decision 4) — so the key is scoped to the workflow, not to the ticket.
      await expect(insertRun(WORKFLOW, key)).resolves.toBeGreaterThan(0);
      await expect(insertRun(second, key)).resolves.toBeGreaterThan(0);
    });

    it('keeps `results` an array', async () => {
      const check = only(await checkDefinition('workflow_runs_results_is_array'));
      expect(check.definition).toContain('jsonb_typeof');

      await expect(
        insertRun(WORKFLOW, 'ticket:results-object', { results: '{"index":0}' }),
      ).rejects.toThrow(/workflow_runs_results_is_array/);

      // Empty is the `skipped` case — the run happened and attempted nothing — and
      // it is also what the claim statement writes, since it does not name the
      // column at all.
      await expect(
        insertRun(WORKFLOW, 'ticket:results-empty', { status: 'skipped' }),
      ).resolves.toBeGreaterThan(0);
    });

    it('carries a failure reason only when it failed', async () => {
      const check = only(await checkDefinition('workflow_runs_failure_reason_only_when_failed'));
      expect(check.definition).toContain('failure_reason IS NULL');

      await expect(
        insertRun(WORKFLOW, 'ticket:succeeded-with-reason', {
          status: 'succeeded',
          failureReason: 'internal_error',
        }),
      ).rejects.toThrow(/workflow_runs_failure_reason_only_when_failed/);

      await expect(
        insertRun(WORKFLOW, 'ticket:failed-with-reason', {
          status: 'failed',
          failureReason: 'reference_missing',
        }),
      ).resolves.toBeGreaterThan(0);

      // The direction deliberately left unconstrained: a `failed` run with no
      // reason yet is what a two-statement transition looks like mid-flight.
      await expect(
        insertRun(WORKFLOW, 'ticket:failed-no-reason', { status: 'failed' }),
      ).resolves.toBeGreaterThan(0);
    });

    it('has the index behind "what automation touched this ticket"', async () => {
      const index = only(await indexDefinition('workflow_runs_tenant_id_ticket_id_created_at_idx'));

      expect(index.indexdef).toContain('(tenant_id, ticket_id, created_at DESC)');
    });
  });

  describe('the evaluation and sweep access paths', () => {
    it('orders active workflows by trigger type and position', async () => {
      const index = only(
        await indexDefinition('workflows_tenant_id_is_active_trigger_type_position_id_idx'),
      );

      // `id` is part of the sort, not decoration: `position` defaults to 0 and is
      // not unique, so without it two workflows created normally need a sort step.
      expect(index.indexdef).toContain('(tenant_id, is_active, trigger_type, "position", id)');
    });

    it('no longer carries the two-column index the evaluation read replaced', async () => {
      // `(tenant_id, is_active)` is a strict prefix of the index above, so leaving
      // it in place would cost a second index's writes for nothing.
      expect(await indexDefinition('workflows_tenant_id_is_active_idx')).toHaveLength(0);
    });

    it('has a partial index holding only the active ticket set', async () => {
      const index = only(await indexDefinition('tickets_active_created_at_idx'));

      // Asserting the definition rather than the name: a predicate quietly widened
      // to every ticket turns a small index into one the size of the table, and a
      // reordering to `(created_at, tenant_id)` would stop serving the per-tenant
      // probe entirely. Both would pass a name-only check.
      expect(index.indexdef).toContain('(tenant_id, created_at)');
      expect(index.indexdef).toMatch(/WHERE \(status = ANY \(.*'open'.*'pending'/s);
    });
  });

  describe('notifications carry the SLA columns for exactly one type', () => {
    const TIMER = '39422222-2222-7222-8222-2222222222f0';
    const POLICY = '39422222-2222-7222-8222-2222222222f1';

    function insertNotification(
      id: string,
      type: string,
      columns: { slaTimerId?: string | null; kind?: string | null; dueAt?: Date | null },
    ): Promise<unknown> {
      return systemPrisma.$executeRaw`
        INSERT INTO notifications (id, tenant_id, type, sla_timer_id, ticket_id,
                                   recipient_user_id, kind, due_at, created_at)
        VALUES (${id}::uuid, ${TENANT}::uuid, ${type}::notification_type,
                ${columns.slaTimerId ?? null}::uuid, ${ticketId}::uuid, ${AGENT}::uuid,
                ${columns.kind ?? null}::sla_target_kind, ${columns.dueAt ?? null}::timestamptz,
                now())
      `;
    }

    beforeAll(async () => {
      await systemPrisma.slaPolicy.create({
        data: {
          id: POLICY,
          tenantId: TENANT,
          name: 'tar394-fixture-policy',
          firstResponseMinutes: 60,
        },
      });
      await systemPrisma.slaTimer.create({
        data: {
          id: TIMER,
          tenantId: TENANT,
          ticketId,
          policyId: POLICY,
          kind: 'first_response',
          state: 'breached',
          dueAt: new Date(Date.now() - 60_000),
        },
      });
    });

    it('is enforced by a CHECK in both directions', async () => {
      const check = only(await checkDefinition('notifications_sla_breach_columns'));

      expect(check.definition).toContain('sla_breach');
      expect(check.definition).toContain('num_nonnulls');
      expect(check.definition).toContain('num_nulls');
    });

    it('accepts a breach with all three, and a workflow row with none', async () => {
      await expect(
        insertNotification('39422222-2222-7222-8222-2222222222f2', 'sla_breach', {
          slaTimerId: TIMER,
          kind: 'first_response',
          dueAt: new Date(),
        }),
      ).resolves.toBeGreaterThan(0);

      await expect(
        insertNotification('39422222-2222-7222-8222-2222222222f3', 'workflow_notify', {}),
      ).resolves.toBeGreaterThan(0);
    });

    it.each([
      ['a breach with no timer', 'sla_breach', {}],
      ['a breach with a timer but no deadline', 'sla_breach', { slaTimerId: TIMER }],
      ['a workflow notification carrying a deadline', 'workflow_notify', { dueAt: new Date() }],
    ] as const)('rejects %s', async (_case, type, columns) => {
      // The last one is why the constraint covers all three columns rather than
      // only `sla_timer_id` as 0009 wrote it: a `workflow_notify` row with a
      // `due_at` renders in the console as a missed deadline that never existed.
      await expect(
        insertNotification('39422222-2222-7222-8222-2222222222f4', type, columns),
      ).rejects.toThrow(/notifications_sla_breach_columns/);
    });

    it('defaults an unqualified insert to the type that has to say so', async () => {
      // The default is not convenience: a writer that forgets the column lands on
      // `sla_breach`, whose CHECK then demands a timer — so it fails loudly instead
      // of inventing a category (0009, decision 7).
      await expect(
        systemPrisma.$executeRaw`
          INSERT INTO notifications (id, tenant_id, ticket_id, recipient_user_id, created_at)
          VALUES ('39422222-2222-7222-8222-2222222222f5'::uuid, ${TENANT}::uuid,
                  ${ticketId}::uuid, ${AGENT}::uuid, now())
        `,
      ).rejects.toThrow(/notifications_sla_breach_columns/);
    });
  });

  describe('through the app role, under RLS', () => {
    const WORKFLOW = '39422222-2222-7222-8222-2222222222e6';

    it('keeps all four new tables inside the tenant boundary', async () => {
      // `verify-tenant-isolation.sql` proves this over a connection that has never
      // set the GUC, which is the fail-closed case. This is the other half: the
      // same tables read through `TenantPrisma` as a *different, real* tenant,
      // which is the shape every request takes.
      await createWorkflow(WORKFLOW, TENANT, 'Escalate stale tickets', true);
      await insertReference(WORKFLOW, TENANT, { tagId: TAG });
      await insertRun(WORKFLOW, `ticket:${ticketId}`);
      await systemPrisma.ticketTag.create({ data: { tenantId: TENANT, ticketId, tagId: TAG } });

      const seen = await asTenant(OTHER_TENANT, async () => ({
        workflows: await tenantPrisma.workflow.count(),
        runs: await tenantPrisma.workflowRun.count(),
        references: await tenantPrisma.workflowReference.count(),
        ticketTags: await tenantPrisma.ticketTag.count(),
      }));

      expect(seen).toEqual({ workflows: 0, runs: 0, references: 0, ticketTags: 0 });

      const own = await asTenant(TENANT, async () => ({
        workflows: await tenantPrisma.workflow.count(),
        runs: await tenantPrisma.workflowRun.count(),
        references: await tenantPrisma.workflowReference.count(),
        ticketTags: await tenantPrisma.ticketTag.count(),
      }));

      expect(own).toEqual({ workflows: 1, runs: 1, references: 1, ticketTags: 1 });
    });

    it('refuses to write a workflow into another tenant', async () => {
      // The `WITH CHECK` half. A handler that took a tenant id from a request body
      // must not be able to arm a rule inside somebody else's helpdesk.
      await expect(
        asTenant(TENANT, () =>
          tenantPrisma.workflow.create({
            data: {
              tenantId: OTHER_TENANT,
              name: 'Planted workflow',
              triggerType: 'ticket_created',
              definition: { trigger: { type: 'ticket_created' }, conditions: [], actions: [] },
            },
          }),
        ),
      ).rejects.toThrow();
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
