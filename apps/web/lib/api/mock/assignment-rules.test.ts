import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssignmentRuleListResponse,
  AssignmentRuleResponse,
  CursorPage,
  CustomFieldDefinition,
  Tag,
  TenantRole,
} from '@whatsappcrm/contracts';

/**
 * The routing-rule half of the mock transport (TAR-289, contract 0007).
 *
 * These are the refusals TAR-289's console is built against, and the only place
 * they can be exercised end to end before TAR-288 lands: cross-tenant isolation,
 * the permission gate, first-match ordering, and the four ways a write is turned
 * down. A fixture layer that said yes to all of them would let every one of those
 * paths through review untested.
 *
 * Kept beside `handlers.test.ts` rather than inside it: that file is already long,
 * and these share one subject.
 */

vi.mock('server-only', () => ({}));

let currentRole: TenantRole = 'supervisor';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'wac_role_stub' ? { name, value: currentRole } : undefined),
    }),
}));

const { handleMockRequest } = await import('./handlers');
const { resetMockState } = await import('./store');
const { MOCK_IDS } = await import('./fixtures');

function asRole(role: TenantRole): void {
  currentRole = role;
}

async function listRules(): Promise<AssignmentRuleListResponse> {
  return (await handleMockRequest({
    method: 'GET',
    path: '/v1/assignment-rules',
  })) as AssignmentRuleListResponse;
}

const KEYWORD_CONDITION = { type: 'keyword', match: 'any', values: ['billing'] } as const;
const TEAM_TARGET = { kind: 'team', teamId: MOCK_IDS.teams.billing } as const;

beforeEach(() => {
  resetMockState();
  asRole('supervisor');
});

describe('tenant scoping', () => {
  it('never returns another tenant’s rules', async () => {
    const page = await listRules();

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((rule) => rule.id)).not.toContain(MOCK_IDS.assignmentRules.otherTenant);
  });

  it('answers 404, not 403, for another tenant’s rule so nothing can be enumerated', async () => {
    const attempt = handleMockRequest({
      method: 'GET',
      path: `/v1/assignment-rules/${MOCK_IDS.assignmentRules.otherTenant}`,
    });

    await expect(attempt).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('refuses a target in another tenant as validation_failed, never not_found', async () => {
    // Row-level security means the id is simply not visible, so the server cannot
    // tell "another tenant's team" from "no such team" — and that
    // indistinguishability is the point.
    const attempt = handleMockRequest({
      method: 'POST',
      path: '/v1/assignment-rules',
      body: {
        name: 'Cross tenant',
        conditions: [KEYWORD_CONDITION],
        target: { kind: 'team', teamId: MOCK_IDS.teams.otherTenant },
      },
    });

    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a condition naming another tenant’s tag', async () => {
    const attempt = handleMockRequest({
      method: 'POST',
      path: '/v1/assignment-rules',
      body: {
        name: 'Cross tenant tag',
        conditions: [{ type: 'tag', match: 'any', tagIds: [MOCK_IDS.tags.otherTenant] }],
        target: TEAM_TARGET,
      },
    });

    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('never returns another tenant’s tags or contact fields', async () => {
    const tags = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tags?limit=100',
    })) as CursorPage<Tag>;
    const fields = (await handleMockRequest({
      method: 'GET',
      path: '/v1/custom-fields?limit=100',
    })) as CursorPage<CustomFieldDefinition>;

    expect(tags.items.map((tag) => tag.id)).not.toContain(MOCK_IDS.tags.otherTenant);
    expect(fields.items.map((field) => field.id)).not.toContain(MOCK_IDS.customFields.otherTenant);
  });
});

describe('permissions', () => {
  it('hides the rules from an agent, who holds neither assignment_rule permission', async () => {
    asRole('agent');

    await expect(listRules()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('lets a supervisor write, per 0007 — not just an admin', async () => {
    const created = (await handleMockRequest({
      method: 'POST',
      path: '/v1/assignment-rules',
      body: { name: 'Supervisor rule', conditions: [KEYWORD_CONDITION], target: TEAM_TARGET },
    })) as AssignmentRuleResponse;

    expect(created.name).toBe('Supervisor rule');
  });
});

describe('ordering', () => {
  it('lists rules by position, which is the order they are evaluated in', async () => {
    const page = await listRules();

    expect(page.items.map((rule) => rule.position)).toStrictEqual([0, 1, 2, 3]);
  });

  it('appends a new rule last rather than making it match first', async () => {
    const created = (await handleMockRequest({
      method: 'POST',
      path: '/v1/assignment-rules',
      body: { name: 'Appended', conditions: [KEYWORD_CONDITION], target: TEAM_TARGET },
    })) as AssignmentRuleResponse;
    const page = await listRules();

    expect(page.items.at(-1)?.id).toBe(created.id);
  });

  it('rewrites every position from the submitted order', async () => {
    const before = await listRules();
    const reversed = [...before.items].reverse().map((rule) => rule.id);

    const after = (await handleMockRequest({
      method: 'POST',
      path: '/v1/assignment-rules/reorder',
      body: { ruleIds: reversed },
    })) as AssignmentRuleListResponse;

    expect(after.items.map((rule) => rule.id)).toStrictEqual(reversed);
  });

  it('refuses a reorder that is not the tenant’s complete rule set', async () => {
    // Another supervisor added or deleted a rule since this client loaded, so a
    // partial reorder would silently drop whatever it did not mention.
    const attempt = handleMockRequest({
      method: 'POST',
      path: '/v1/assignment-rules/reorder',
      body: { ruleIds: [MOCK_IDS.assignmentRules.billingKeywords] },
    });

    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('does not paginate, because the set is capped per tenant', async () => {
    const page = await listRules();

    expect(page.nextCursor).toBeNull();
  });
});

describe('refusals a supervisor can act on', () => {
  it('refuses a duplicate name, case-insensitively', async () => {
    const attempt = handleMockRequest({
      method: 'POST',
      path: '/v1/assignment-rules',
      body: { name: 'billing KEYWORDS', conditions: [KEYWORD_CONDITION], target: TEAM_TARGET },
    });

    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('refuses a rule with no conditions, which would swallow all routing', async () => {
    const attempt = handleMockRequest({
      method: 'POST',
      path: '/v1/assignment-rules',
      body: { name: 'Everything', conditions: [], target: TEAM_TARGET },
    });

    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses to enable a rule whose target was removed', async () => {
    const attempt = handleMockRequest({
      method: 'PATCH',
      path: `/v1/assignment-rules/${MOCK_IDS.assignmentRules.orphaned}`,
      body: { isActive: true },
    });

    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('enables that rule once it has been given a target again', async () => {
    const updated = (await handleMockRequest({
      method: 'PATCH',
      path: `/v1/assignment-rules/${MOCK_IDS.assignmentRules.orphaned}`,
      body: { target: TEAM_TARGET, isActive: true },
    })) as AssignmentRuleResponse;

    expect(updated.isActive).toBe(true);
    expect(updated.target).toStrictEqual(TEAM_TARGET);
  });
});

describe('deletion', () => {
  it('is idempotent — deleting an already-deleted rule is not an error', async () => {
    const path = `/v1/assignment-rules/${MOCK_IDS.assignmentRules.vipContacts}`;

    await handleMockRequest({ method: 'DELETE', path });
    await expect(handleMockRequest({ method: 'DELETE', path })).resolves.toBeNull();
  });

  it('leaves the remaining rules in the same relative order', async () => {
    await handleMockRequest({
      method: 'DELETE',
      path: `/v1/assignment-rules/${MOCK_IDS.assignmentRules.outOfHours}`,
    });

    const page = await listRules();

    expect(page.items.map((rule) => rule.id)).toStrictEqual([
      MOCK_IDS.assignmentRules.billingKeywords,
      MOCK_IDS.assignmentRules.vipContacts,
      MOCK_IDS.assignmentRules.orphaned,
    ]);
  });
});
