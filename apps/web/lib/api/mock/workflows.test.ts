import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CursorPage,
  TenantRole,
  WorkflowCatalogResponse,
  WorkflowListResponse,
  WorkflowResponse,
  WorkflowRunResponse,
  WorkflowTestResponse,
} from '@whatsappcrm/contracts';

/**
 * The workflow half of the mock transport (TAR-396, contract 0009).
 *
 * These are the refusals the builder is built against, and the only place they
 * can be exercised end to end before TAR-395 lands: cross-tenant isolation, the
 * permission gate, execution order, the two per-tenant caps, the one new error
 * code — and, most of all, that taxonomy names are resolved **live** rather than
 * stored, which is TAR-27's second acceptance criterion.
 *
 * Kept beside `assignment-rules.test.ts` rather than inside `handlers.test.ts`,
 * for the same reason that file exists: one subject per file.
 */

vi.mock('server-only', () => ({}));

let currentRole: TenantRole = 'admin';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'wac_role_stub' ? { name, value: currentRole } : undefined),
    }),
}));

const { handleMockRequest } = await import('./handlers');
const { resetMockState, mockState } = await import('./store');
const { MOCK_IDS } = await import('./fixtures');

function asRole(role: TenantRole): void {
  currentRole = role;
}

async function listWorkflows(): Promise<WorkflowListResponse> {
  return (await handleMockRequest({
    method: 'GET',
    path: '/v1/workflows',
  })) as WorkflowListResponse;
}

async function getWorkflow(id: string): Promise<WorkflowResponse> {
  return (await handleMockRequest({
    method: 'GET',
    path: `/v1/workflows/${id}`,
  })) as WorkflowResponse;
}

const TAG_ACTION = { type: 'add_ticket_tag', tagId: MOCK_IDS.tags.escalated } as const;
const TRIGGER = { type: 'ticket_created' } as const;

beforeEach(() => {
  resetMockState();
  // Admin, because `rbac.ts` still grants `workflow:*` to admin alone. ADR 0009
  // moves both to supervisor and TAR-395 owns that edit; the supervisor case
  // below is what will start passing the moment it lands.
  asRole('admin');
});

describe('tenant scoping', () => {
  it('never returns another tenant’s workflows', async () => {
    const page = await listWorkflows();

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((workflow) => workflow.id)).not.toContain(MOCK_IDS.workflows.otherTenant);
  });

  it('answers 404, not 403, for another tenant’s workflow', async () => {
    const attempt = getWorkflow(MOCK_IDS.workflows.otherTenant);

    await expect(attempt).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('refuses an action naming another tenant’s tag as validation_failed', async () => {
    // Row-level security means the id is simply not visible, so the server cannot
    // tell "another tenant's tag" from "no such tag" — and that
    // indistinguishability is the point.
    const attempt = handleMockRequest({
      method: 'POST',
      path: '/v1/workflows',
      body: {
        name: 'Cross tenant tag',
        trigger: TRIGGER,
        actions: [{ type: 'add_ticket_tag', tagId: MOCK_IDS.tags.otherTenant }],
      },
    });

    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('never returns another tenant’s runs', async () => {
    const page = (await handleMockRequest({
      method: 'GET',
      path: `/v1/workflows/${MOCK_IDS.workflows.escalateStale}/runs?limit=25`,
    })) as CursorPage<WorkflowRunResponse>;

    expect(page.items.map((run) => run.id)).not.toContain(MOCK_IDS.workflowRuns.otherTenant);
  });
});

describe('permissions', () => {
  it('hides the workflows from an agent, who holds neither workflow permission', async () => {
    asRole('agent');

    await expect(listWorkflows()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('refuses the dry run to a role without a workflow permission', async () => {
    // It reports facts about one ticket the caller may not otherwise be entitled
    // to see — 0009 gates it on `workflow:write` for exactly that reason — so a
    // role holding neither must not reach it.
    asRole('agent');

    const attempt = handleMockRequest({
      method: 'POST',
      path: `/v1/workflows/${MOCK_IDS.workflows.urgentToBilling}/test`,
      body: { ticketId: MOCK_IDS.tickets.fatimaUrgent },
    });

    await expect(attempt).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('execution order', () => {
  it('lists workflows by position, which is the order they run in', async () => {
    const page = await listWorkflows();

    expect(page.items.map((workflow) => workflow.position)).toStrictEqual([0, 1, 2]);
  });

  it('appends a new workflow last rather than making it run first', async () => {
    const created = (await handleMockRequest({
      method: 'POST',
      path: '/v1/workflows',
      body: { name: 'Appended', trigger: TRIGGER, actions: [TAG_ACTION] },
    })) as WorkflowResponse;
    const page = await listWorkflows();

    expect(page.items.at(-1)?.id).toBe(created.id);
  });

  it('rewrites every position from the submitted order', async () => {
    const before = await listWorkflows();
    const reversed = [...before.items].reverse().map((workflow) => workflow.id);

    const after = (await handleMockRequest({
      method: 'POST',
      path: '/v1/workflows/reorder',
      body: { workflowIds: reversed },
    })) as WorkflowListResponse;

    expect(after.items.map((workflow) => workflow.id)).toStrictEqual(reversed);
  });

  it('refuses a reorder that is not the tenant’s complete set', async () => {
    const attempt = handleMockRequest({
      method: 'POST',
      path: '/v1/workflows/reorder',
      body: { workflowIds: [MOCK_IDS.workflows.escalateStale] },
    });

    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('does not paginate, because the set is capped per tenant', async () => {
    expect((await listWorkflows()).nextCursor).toBeNull();
  });
});

describe('taxonomy references — TAR-27 acceptance criterion 2', () => {
  it('resolves names live, so a rename needs no write to the workflow', async () => {
    const before = await getWorkflow(MOCK_IDS.workflows.escalateStale);
    const tag = mockState().tags.get(MOCK_IDS.tags.escalated);

    expect(before.references).toContainEqual(
      expect.objectContaining({ kind: 'tag', name: 'Escalated', exists: true }),
    );

    // Rename the tag elsewhere — nothing touches the workflow row.
    mockState().tags.set(MOCK_IDS.tags.escalated, { ...tag!, name: 'Escalated!' });

    const after = await getWorkflow(MOCK_IDS.workflows.escalateStale);

    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.references).toContainEqual(
      expect.objectContaining({ kind: 'tag', name: 'Escalated!', exists: true }),
    );
  });

  it('reports a reference that no longer exists rather than hiding it', async () => {
    const broken = await getWorkflow(MOCK_IDS.workflows.brokenNotify);

    expect(broken.references).toStrictEqual([
      { kind: 'user', id: MOCK_IDS.removedUser, name: null, exists: false },
    ]);
    expect(broken.brokenReason).toBe('reference_removed');
  });

  it('refuses to arm a workflow whose reference is broken, with its own code', async () => {
    // Not `validation_failed`: the body is well-formed and the caller changed
    // nothing — a colleague removed the agent. The console's next action is
    // "pick a replacement", not "fix your input".
    const attempt = handleMockRequest({
      method: 'PATCH',
      path: `/v1/workflows/${MOCK_IDS.workflows.brokenNotify}`,
      body: { isActive: true },
    });

    await expect(attempt).rejects.toMatchObject({ code: 'workflow_reference_broken' });
  });

  it('arms it once the missing target has been replaced', async () => {
    const updated = (await handleMockRequest({
      method: 'PATCH',
      path: `/v1/workflows/${MOCK_IDS.workflows.brokenNotify}`,
      body: {
        actions: [
          {
            type: 'notify',
            audience: 'user',
            userId: MOCK_IDS.users.priya,
            teamId: null,
            message: null,
          },
        ],
        isActive: true,
      },
    })) as WorkflowResponse;

    expect(updated.isActive).toBe(true);
    expect(updated.brokenReason).toBeNull();
    expect(updated.references.every((reference) => reference.exists)).toBe(true);
  });
});

describe('refusals a supervisor can act on', () => {
  it('refuses a duplicate name, case-insensitively', async () => {
    const attempt = handleMockRequest({
      method: 'POST',
      path: '/v1/workflows',
      body: { name: 'escalate STALE tickets', trigger: TRIGGER, actions: [TAG_ACTION] },
    });

    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('refuses a workflow with no actions', async () => {
    const attempt = handleMockRequest({
      method: 'POST',
      path: '/v1/workflows',
      body: { name: 'Does nothing', trigger: TRIGGER, actions: [] },
    });

    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('accepts a workflow with no conditions, which a routing rule may not be', async () => {
    const created = (await handleMockRequest({
      method: 'POST',
      path: '/v1/workflows',
      body: { name: 'Tag everything new', trigger: TRIGGER, conditions: [], actions: [TAG_ACTION] },
    })) as WorkflowResponse;

    expect(created.conditions).toStrictEqual([]);
  });

  it('creates a workflow switched off, whatever else it was asked for', async () => {
    const created = (await handleMockRequest({
      method: 'POST',
      path: '/v1/workflows',
      body: { name: 'Not armed yet', trigger: TRIGGER, actions: [TAG_ACTION] },
    })) as WorkflowResponse;

    expect(created.isActive).toBe(false);
  });

  it('caps the workflows a tenant may hold with conflict, not a billing error', async () => {
    const state = mockState();
    const seed = state.workflows.get(MOCK_IDS.workflows.escalateStale);

    for (let index = 0; index < 50; index += 1) {
      const id = `0192f0ff-0000-7000-8000-0000000${String(index).padStart(5, '0')}`;

      state.workflows.set(id, {
        ...seed!,
        id,
        name: `Filler ${String(index)}`,
        position: 10 + index,
      });
    }

    const attempt = handleMockRequest({
      method: 'POST',
      path: '/v1/workflows',
      body: { name: 'One too many', trigger: TRIGGER, actions: [TAG_ACTION] },
    });

    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });
});

describe('versioning', () => {
  it('bumps the version when the definition changes', async () => {
    const updated = (await handleMockRequest({
      method: 'PATCH',
      path: `/v1/workflows/${MOCK_IDS.workflows.urgentToBilling}`,
      body: { conditions: [] },
    })) as WorkflowResponse;

    expect(updated.version).toBe(2);
  });

  it('leaves it alone for a rename, because nothing about execution changed', async () => {
    const updated = (await handleMockRequest({
      method: 'PATCH',
      path: `/v1/workflows/${MOCK_IDS.workflows.urgentToBilling}`,
      body: { name: 'Urgent to Billing' },
    })) as WorkflowResponse;

    expect(updated.version).toBe(1);
  });

  it('leaves the conditions alone when only the switch is sent', async () => {
    // The regression `WorkflowUpdateInputSchema` is written out longhand to
    // prevent: `.partial()` keeps a field's `.default()`, so a bare
    // `{ isActive }` would arrive carrying `conditions: []` and delete them.
    const before = await getWorkflow(MOCK_IDS.workflows.urgentToBilling);

    const updated = (await handleMockRequest({
      method: 'PATCH',
      path: `/v1/workflows/${MOCK_IDS.workflows.urgentToBilling}`,
      body: { isActive: false },
    })) as WorkflowResponse;

    expect(updated.conditions).toStrictEqual(before.conditions);
    expect(updated.version).toBe(before.version);
  });
});

describe('the dry run', () => {
  it('reports what would happen and writes nothing', async () => {
    const before = mockState().workflowRuns.size;

    const result = (await handleMockRequest({
      method: 'POST',
      path: `/v1/workflows/${MOCK_IDS.workflows.urgentToBilling}/test`,
      body: { ticketId: MOCK_IDS.tickets.fatimaUrgent },
    })) as WorkflowTestResponse;

    expect(result.matched).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.describes).toContain('Billing');
    expect(mockState().workflowRuns.size).toBe(before);
  });

  it('reports no actions at all when the conditions did not match', async () => {
    const result = (await handleMockRequest({
      method: 'POST',
      path: `/v1/workflows/${MOCK_IDS.workflows.urgentToBilling}/test`,
      body: { ticketId: MOCK_IDS.tickets.jonasPending },
    })) as WorkflowTestResponse;

    expect(result.matched).toBe(false);
    expect(result.actions).toStrictEqual([]);
    expect(result.conditions[0]?.held).toBe(false);
  });
});

describe('the catalog', () => {
  it('publishes every trigger, condition and action the grammar has', async () => {
    const catalog = (await handleMockRequest({
      method: 'GET',
      path: '/v1/workflow-catalog',
    })) as WorkflowCatalogResponse;

    expect(catalog.triggers).toHaveLength(5);
    expect(catalog.conditions).toHaveLength(7);
    expect(catalog.actions).toHaveLength(5);
    expect(catalog.limits.workflowsPerTenant).toBe(50);
  });

  it('carries the elapsed trigger’s bounds, so a form cannot offer one it refuses', async () => {
    const catalog = (await handleMockRequest({
      method: 'GET',
      path: '/v1/workflow-catalog',
    })) as WorkflowCatalogResponse;
    const elapsed = catalog.triggers.find((trigger) => trigger.type === 'ticket_unresolved_for');

    expect(elapsed?.parameters[0]).toMatchObject({ name: 'minutes', min: 5, max: 43_200 });
  });
});

describe('deletion', () => {
  it('is idempotent — deleting an already-deleted workflow is not an error', async () => {
    const path = `/v1/workflows/${MOCK_IDS.workflows.urgentToBilling}`;

    await handleMockRequest({ method: 'DELETE', path });
    await expect(handleMockRequest({ method: 'DELETE', path })).resolves.toBeNull();
  });

  it('takes its runs with it, as the foreign key cascade does', async () => {
    await handleMockRequest({
      method: 'DELETE',
      path: `/v1/workflows/${MOCK_IDS.workflows.escalateStale}`,
    });

    const remaining = [...mockState().workflowRuns.values()].filter(
      (run) => run.workflowId === MOCK_IDS.workflows.escalateStale,
    );

    expect(remaining).toStrictEqual([]);
  });
});
