import type { WorkflowDefinition, WorkflowUpdateInput } from '@whatsappcrm/contracts';
import type { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { WorkflowService } from './workflow.service';
import { WorkflowReferenceBrokenError } from './workflows.errors';

/**
 * `brokenReason` is derived state, not a latch — and the two-step repair that
 * follows from it (TAR-399's ruling on 0009 decision 6, mechanism 3).
 *
 * The rule this file pins, in the order the ruling states it:
 *
 *   1. **Clearing.** Every write recomputes the post-patch reference set and
 *      sets `brokenReason` to `null` when all of them resolve — *independent of
 *      `isActive`*.
 *   2. **Arming.** `isActive: true` is refused with `workflow_reference_broken`
 *      **iff** some post-patch reference does not resolve, never because
 *      `brokenReason` was set, and `details` always names the offenders.
 *   3. **The invariant.** `brokenReason IS NOT NULL` implies at least one
 *      reference does not resolve, which is what makes the field safe to render
 *      and safe to ignore as a gate.
 *
 * The case that mattered and had no test is the repair the console actually
 * produces: the edit form carries `isActive` through unchanged, so the fix is
 * always `isActive: false` and arming is a *separate* request from the list.
 */

const TENANT = '019fed83-0000-7000-8000-00000000b001';
const WORKFLOW = '019fed83-0000-7000-8000-00000000b002';
/** In the tenant, so a live read finds it. */
const LIVE_USER = '019fed83-0000-7000-8000-00000000b003';
/**
 * Removed — and **still a row**, with `status: 'removed'`. This is the id a
 * disarmed workflow is carrying, and the one a read without a status filter
 * happily resolves.
 */
const REMOVED_USER = '019fed83-0000-7000-8000-00000000b004';

function notifying(userId: string): WorkflowDefinition {
  return {
    trigger: { type: 'ticket_created' },
    conditions: [],
    actions: [{ type: 'notify', audience: 'user', userId, teamId: null, message: null }],
  };
}

interface StoredWorkflow {
  id: string;
  name: string;
  position: number;
  isActive: boolean;
  brokenReason: 'reference_removed' | 'reference_missing' | null;
  triggerType: string;
  definition: WorkflowDefinition;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface Harness {
  readonly update: (input: WorkflowUpdateInput) => Promise<unknown>;
  /** The row as the fake database now holds it. */
  readonly stored: () => StoredWorkflow;
  /** User ids written to the reverse index by the last definition write. */
  readonly indexed: () => string[];
}

/**
 * A stand-in for `workflows` plus the three taxonomy reads, with the one
 * behaviour that matters: `LIVE_USER` resolves and `REMOVED_USER` does not, which
 * is what a removed user looks like through RLS.
 */
function harness(seed: Partial<StoredWorkflow>): Harness {
  const row: StoredWorkflow = {
    id: WORKFLOW,
    name: 'Notify on new tickets',
    position: 0,
    isActive: false,
    brokenReason: 'reference_removed',
    triggerType: 'ticket_created',
    definition: notifying(REMOVED_USER),
    version: 3,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...seed,
  };

  let indexed: string[] = [];

  /**
   * The tenant's users **as rows**, with a status — because removal is a status
   * change and not a delete, so `REMOVED_USER` is still there to be found by any
   * read that forgets to filter. A stub that modelled removal as absence could
   * not catch the bug this file pins.
   */
  const userRows = [
    { id: LIVE_USER, name: 'Priya', status: 'active' },
    { id: REMOVED_USER, name: 'Sam', status: 'removed' },
  ];

  const taxonomy = {
    tag: { findMany: () => Promise.resolve([]) },
    team: { findMany: () => Promise.resolve([]) },
    user: {
      findMany: ({ where }: { where: { id: { in: string[] }; status?: string } }) =>
        Promise.resolve(
          userRows
            .filter(
              (row) =>
                where.id.in.includes(row.id) &&
                (where.status === undefined || row.status === where.status),
            )
            .map(({ id, name }) => ({ id, name })),
        ),
    },
  };

  const tx = {
    ...taxonomy,
    workflow: {
      findUnique: () => Promise.resolve({ ...row }),
      count: () => Promise.resolve(1),
      updateMany: () => Promise.resolve({ count: 1 }),
      aggregate: () => Promise.resolve({ _max: { position: 0 } }),
      update: ({ data }: { data: Record<string, unknown> }) => {
        if ('name' in data) row.name = data.name as string;
        if ('isActive' in data) row.isActive = data.isActive as boolean;
        if ('brokenReason' in data) row.brokenReason = data.brokenReason as null;
        if ('definition' in data) row.definition = data.definition as WorkflowDefinition;
        if ('triggerType' in data) row.triggerType = data.triggerType as string;

        return Promise.resolve({ ...row });
      },
    },
    workflowReference: {
      deleteMany: () => {
        indexed = [];
        return Promise.resolve({ count: 0 });
      },
      createMany: ({ data }: { data: { userId: string | null }[] }) => {
        indexed = data.flatMap((entry) => (entry.userId === null ? [] : [entry.userId]));
        return Promise.resolve({ count: data.length });
      },
    },
    auditLog: { create: () => Promise.resolve({}) },
  };

  const prisma = {
    ...taxonomy,
    workflow: { findUnique: () => Promise.resolve({ ...row }) },
    $tenantTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as TenantPrisma;

  const tenantContext = new TenantContextService();
  const service = new WorkflowService(prisma, tenantContext, {
    record: () => Promise.resolve(),
  } as unknown as AuditService);

  return {
    update: async (input) =>
      await tenantContext.run(
        { requestId: 'workflow-spec', tenantId: TENANT, userId: null },
        async () => await service.update(WORKFLOW, input),
      ),
    stored: () => row,
    indexed: () => indexed,
  };
}

describe('the two-step repair the console produces', () => {
  it('clears brokenReason on a repair that does not arm', async () => {
    // Step one. `WorkflowFormDialog` carries `isActive` through unchanged, so
    // the repair PATCH is always `isActive: false` — which is exactly the
    // request the old rule ignored, leaving the workflow permanently broken.
    const held = harness({});

    await held.update({ actions: notifying(LIVE_USER).actions });

    expect(held.stored().brokenReason).toBeNull();
    expect(held.stored().isActive).toBe(false);
  });

  it('then arms on a bare isActive, with no definition echoed back', async () => {
    // Step two, from the list. Under the old rule this threw
    // `workflow_reference_broken` with an empty `details`, and the only remedy
    // was delete-and-recreate — which discards run history and position.
    const held = harness({});

    await held.update({ actions: notifying(LIVE_USER).actions });
    await held.update({ isActive: true });

    expect(held.stored().isActive).toBe(true);
    expect(held.stored().brokenReason).toBeNull();
  });

  it('arms in one combined request too, which is the shape the mock already had', async () => {
    const held = harness({});

    await held.update({ actions: notifying(LIVE_USER).actions, isActive: true });

    expect(held.stored().isActive).toBe(true);
    expect(held.stored().brokenReason).toBeNull();
  });
});

describe('arming while a reference is still unresolved', () => {
  it('is refused, and names each offender in details', async () => {
    // Rule 2. An empty `details` is itself a contract violation — the console
    // has nothing to highlight, which is what the code the ruling deleted did.
    const held = harness({});

    const refusal = await held.update({ isActive: true }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(WorkflowReferenceBrokenError);
    expect((refusal as WorkflowReferenceBrokenError).broken).toHaveLength(1);
    expect((refusal as WorkflowReferenceBrokenError).broken[0]).toMatchObject({
      kind: 'user',
      id: REMOVED_USER,
    });
    expect((refusal as WorkflowReferenceBrokenError).broken[0]?.path).toContain('actions.0');
    expect(held.stored().isActive).toBe(false);
  });

  it('is refused even when brokenReason was already null', async () => {
    // The gate is the reference set, never the field. A row whose `brokenReason`
    // was cleared by some other write must still not arm while an id is dead.
    const held = harness({ brokenReason: null });

    await expect(held.update({ isActive: true })).rejects.toBeInstanceOf(
      WorkflowReferenceBrokenError,
    );
  });

  it('leaves brokenReason standing, so the invariant holds', async () => {
    // Rule 3: `brokenReason IS NOT NULL` implies something does not resolve. A
    // write that repairs nothing must not clear it.
    const held = harness({});

    await held.update({ name: 'Renamed but still broken' });

    expect(held.stored().brokenReason).toBe('reference_removed');
    expect(held.stored().name).toBe('Renamed but still broken');
  });
});

describe('a removed user is not referenceable, so the arm/fail loop cannot start', () => {
  it('does not resolve a removed user, even though the row is still there', async () => {
    // Removal is a status change, not a delete. A name lookup with no status
    // filter finds the row and reports `exists: true` — which is what let a
    // workflow be armed against somebody the executor would then refuse to use.
    const held = harness({});

    const refusal = await held.update({ isActive: true }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(WorkflowReferenceBrokenError);
    expect((refusal as WorkflowReferenceBrokenError).broken[0]).toMatchObject({
      kind: 'user',
      id: REMOVED_USER,
    });
  });

  it('keeps brokenReason standing across a write that repairs nothing else', async () => {
    // The step that closed the loop: `brokenReason` cleared, the console offered
    // Enable, the first ticket failed `reference_missing`, the workflow
    // auto-disarmed, and round it went. The reference must stay unresolved.
    const held = harness({});

    await held.update({ name: 'Still pointing at somebody who left' });

    expect(held.stored().brokenReason).toBe('reference_removed');
  });

  it('resolves again only once the definition names an active user', async () => {
    // And then the repair works exactly as before — the fix narrows what counts
    // as resolvable, it does not make repair harder.
    const held = harness({});

    await held.update({ actions: notifying(LIVE_USER).actions });
    await held.update({ isActive: true });

    expect(held.stored().isActive).toBe(true);
    expect(held.stored().brokenReason).toBeNull();
  });
});

describe('the reverse index', () => {
  it('carries only references that resolve', async () => {
    // `workflow_references` exists to make a *delete* refusable, and a row that
    // is already gone needs no protection — while its composite foreign key
    // would refuse the insert outright. The dangling id stays in `definition`,
    // which is where 0009 decision 6 puts it.
    const held = harness({});

    await held.update({
      actions: [
        ...notifying(LIVE_USER).actions,
        { type: 'notify', audience: 'user', userId: REMOVED_USER, teamId: null, message: null },
      ],
    });

    expect(held.indexed()).toEqual([LIVE_USER]);
    // Still broken, because the definition still names the dead id.
    expect(held.stored().brokenReason).toBe('reference_removed');
  });
});
