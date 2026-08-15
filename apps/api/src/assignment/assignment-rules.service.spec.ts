import { ROUTING_RULE_LIMITS, type RoutingCondition } from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { AssignmentRulesService } from './assignment-rules.service';
import {
  AssignmentRuleNotFoundError,
  RuleNeedsTargetError,
  RuleSetChangedError,
  TooManyAssignmentRulesError,
  UnknownRuleReferenceError,
} from './assignment.errors';

/**
 * The rule-writing invariants that do not need a database to state.
 *
 * The ones that do — RLS, the CHECK constraint, the unique index on
 * `(tenant_id, name)` — are in `routing-rules.int-spec.ts`, because asserting
 * them against a fake would only prove the fake agrees with itself.
 *
 * Fake transaction rather than jest mocks, matching `teams.service.spec.ts`: the
 * real service body runs, so the order of the checks and the statements it
 * issues are what is under test.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000b1';
const TEAM = '0192f0ff-0000-7000-8000-0000000000t1';
const SARA = '0192f0ff-0000-7000-8000-0000000000u1';
const RULE_A = '0192f0ff-0000-7000-8000-00000000r001';
const RULE_B = '0192f0ff-0000-7000-8000-00000000r002';
// Real UUIDs, unlike the ids above: `IdSchema` validates every `tagIds` entry on
// the way in, so a readable placeholder would fail the grammar before reaching
// the check under test.
const TAG = '0192f0ff-0000-7000-8000-00000000a001';
/** Deleted, or another tenant's — indistinguishable from here, and deliberately so. */
const OTHER_TENANT_TAG = '0192f0ff-0000-7000-8000-00000000a999';

const KEYWORD: RoutingCondition = { type: 'keyword', match: 'any', values: ['invoice'] };

interface RuleRow {
  id: string;
  name: string;
  position: number;
  isActive: boolean;
  conditions: unknown;
  targetUserId: string | null;
  targetTeamId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface WorldOptions {
  rules?: Partial<RuleRow>[];
  /** Teams and users that exist in this tenant. */
  teams?: string[];
  users?: string[];
  customFieldKeys?: string[];
  tags?: string[];
}

interface Recorded {
  created: Record<string, unknown>[];
  updated: { where: Record<string, unknown>; data: Record<string, unknown> }[];
  updatedMany: { where: Record<string, unknown>; data: Record<string, unknown> }[];
  deleted: string[];
  audited: string[];
}

function ruleRow(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: RULE_A,
    name: 'Billing keywords',
    position: 0,
    isActive: true,
    conditions: [KEYWORD],
    targetUserId: null,
    targetTeamId: TEAM,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildWorld(options: WorldOptions = {}): {
  rules: AssignmentRulesService;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    created: [],
    updated: [],
    updatedMany: [],
    deleted: [],
    audited: [],
  };
  const rows = (options.rules ?? []).map(ruleRow);

  const tx = {
    assignmentRule: {
      count: () => Promise.resolve(rows.length),
      aggregate: () =>
        Promise.resolve({
          _max: { position: rows.length === 0 ? null : Math.max(...rows.map((r) => r.position)) },
        }),
      findMany: () => Promise.resolve(rows),
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        recorded.created.push(data);
        return Promise.resolve(ruleRow(data as Partial<RuleRow>));
      },
      update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        recorded.updated.push(args);
        return Promise.resolve(ruleRow(args.data as Partial<RuleRow>));
      },
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        recorded.updatedMany.push(args);
        return Promise.resolve({ count: 1 });
      },
      delete: ({ where }: { where: { id: string } }) => {
        recorded.deleted.push(where.id);
        return Promise.resolve({});
      },
    },
    team: {
      findUnique: ({ where }: { where: { tenantId_id: { id: string } } }) =>
        Promise.resolve(
          (options.teams ?? []).includes(where.tenantId_id.id)
            ? { id: where.tenantId_id.id }
            : null,
        ),
    },
    user: {
      findUnique: ({ where }: { where: { tenantId_id: { id: string } } }) =>
        Promise.resolve(
          (options.users ?? []).includes(where.tenantId_id.id)
            ? { id: where.tenantId_id.id }
            : null,
        ),
    },
    customFieldDef: {
      findMany: ({ where }: { where: { key: { in: string[] } } }) =>
        Promise.resolve(
          where.key.in
            .filter((key) => (options.customFieldKeys ?? []).includes(key))
            .map((key) => ({ key })),
        ),
    },
    tag: {
      // Tenant-scoped in the real query, and the fake honours that by listing
      // only this tenant's tags: an id belonging to anyone else is simply absent.
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.filter((id) => (options.tags ?? []).includes(id)).map((id) => ({ id })),
        ),
    },
  };

  const prisma = {
    assignmentRule: tx.assignmentRule,
    $tenantTransaction: <T>(work: (client: unknown) => Promise<T>) => work(tx),
  } as unknown as TenantPrisma;

  const tenantContext = { requireTenantId: () => TENANT } as unknown as TenantContextService;

  const audit = {
    record: (_tx: unknown, entry: { action: string }) => {
      recorded.audited.push(entry.action);
      return Promise.resolve();
    },
  } as unknown as AuditService;

  return { rules: new AssignmentRulesService(prisma, tenantContext, audit), recorded };
}

describe('creating a rule', () => {
  it('appends it last when no position is given', async () => {
    const { rules, recorded } = buildWorld({
      rules: [
        { id: RULE_A, position: 0 },
        { id: RULE_B, position: 4 },
      ],
      teams: [TEAM],
    });

    await rules.create({
      name: 'New rule',
      conditions: [KEYWORD],
      target: { kind: 'team', teamId: TEAM },
      isActive: true,
    });

    expect(recorded.created[0]?.position).toBe(5);
  });

  it('starts at zero for the tenant’s first rule', async () => {
    const { rules, recorded } = buildWorld({ teams: [TEAM] });

    await rules.create({
      name: 'First',
      conditions: [KEYWORD],
      target: { kind: 'team', teamId: TEAM },
      isActive: true,
    });

    expect(recorded.created[0]?.position).toBe(0);
  });

  it('refuses a target that is not in this tenant, naming the field', async () => {
    // `validation_failed` naming the field, never `not_found`: RLS means the
    // server cannot tell another tenant's team from a team that never existed,
    // and that indistinguishability is the point.
    const { rules } = buildWorld({ teams: [] });

    await expect(
      rules.create({
        name: 'Cross-tenant',
        conditions: [KEYWORD],
        target: { kind: 'team', teamId: TEAM },
        isActive: true,
      }),
    ).rejects.toThrow(UnknownRuleReferenceError);
  });

  it('refuses a contact_attribute key that names no custom field definition', async () => {
    // A key with no definition is a typo that would silently never match, and a
    // rule that never fires is the hardest kind of routing bug to see.
    const { rules } = buildWorld({ teams: [TEAM], customFieldKeys: ['plan'] });

    await expect(
      rules.create({
        name: 'Typo',
        conditions: [{ type: 'contact_attribute', key: 'paln', operator: 'is_set', value: null }],
        target: { kind: 'team', teamId: TEAM },
        isActive: true,
      }),
    ).rejects.toThrow(UnknownRuleReferenceError);
  });

  it('accepts a contact_attribute key that is defined', async () => {
    const { rules } = buildWorld({ teams: [TEAM], customFieldKeys: ['plan'] });

    await expect(
      rules.create({
        name: 'By plan',
        conditions: [{ type: 'contact_attribute', key: 'plan', operator: 'is_set', value: null }],
        target: { kind: 'team', teamId: TEAM },
        isActive: true,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a tag id that is not in this tenant, naming the field', async () => {
    // A tag the supervisor deleted, or one belonging to another tenant. Neither
    // is a leak — the engine's `contact_tags` read is tenant-scoped, so the id
    // simply matches nothing — but the rule saves, reports success, and then
    // never fires again with no error anywhere. That is the version of this bug
    // nobody can debug from the console, which is why it is refused on write.
    const { rules } = buildWorld({ teams: [TEAM], tags: [TAG] });

    await expect(
      rules.create({
        name: 'Dead tag',
        conditions: [{ type: 'tag', match: 'any', tagIds: [OTHER_TENANT_TAG] }],
        target: { kind: 'team', teamId: TEAM },
        isActive: true,
      }),
    ).rejects.toThrow(UnknownRuleReferenceError);
  });

  it('refuses the rule when only one id of several is unknown', async () => {
    const { rules } = buildWorld({ teams: [TEAM], tags: [TAG] });

    await expect(
      rules.create({
        name: 'One good one dead',
        conditions: [{ type: 'tag', match: 'any', tagIds: [TAG, OTHER_TENANT_TAG] }],
        target: { kind: 'team', teamId: TEAM },
        isActive: true,
      }),
    ).rejects.toThrow(UnknownRuleReferenceError);
  });

  it('accepts tag ids the tenant holds', async () => {
    const { rules } = buildWorld({ teams: [TEAM], tags: [TAG] });

    await expect(
      rules.create({
        name: 'VIPs',
        conditions: [{ type: 'tag', match: 'any', tagIds: [TAG] }],
        target: { kind: 'team', teamId: TEAM },
        isActive: true,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a rule past the per-tenant cap, as a conflict rather than a plan limit', async () => {
    // The cap is a property of the engine — one ticket costs
    // `rules × conditions × values` comparisons on a shared worker — not of the
    // tenant's plan, so `402` would send a supervisor to the billing page to fix
    // something money cannot.
    const { rules } = buildWorld({
      rules: Array.from({ length: ROUTING_RULE_LIMITS.rulesPerTenant }, (_, index) => ({
        id: `rule-${index}`,
        position: index,
      })),
      teams: [TEAM],
    });

    await expect(
      rules.create({
        name: 'One too many',
        conditions: [KEYWORD],
        target: { kind: 'team', teamId: TEAM },
        isActive: true,
      }),
    ).rejects.toThrow(TooManyAssignmentRulesError);
  });
});

describe('updating a rule', () => {
  it('refuses to enable a rule that has no target', async () => {
    // The API half of a CHECK constraint that is conditional on `is_active`, so
    // that `UsersService` can leave a target-less inactive rule behind when a
    // target user is removed. Refusing here tells the supervisor what is
    // missing instead of showing them a constraint violation.
    const { rules } = buildWorld({
      rules: [{ id: RULE_A, isActive: false, targetTeamId: null, targetUserId: null }],
    });

    await expect(rules.update(RULE_A, { isActive: true })).rejects.toThrow(RuleNeedsTargetError);
  });

  it('allows enabling and naming a target in one call', async () => {
    const { rules } = buildWorld({
      rules: [{ id: RULE_A, isActive: false, targetTeamId: null, targetUserId: null }],
      users: [SARA],
    });

    await expect(
      rules.update(RULE_A, { isActive: true, target: { kind: 'user', userId: SARA } }),
    ).resolves.toBeDefined();
  });

  it('leaves a target-less rule alone while it stays disabled', async () => {
    const { rules } = buildWorld({
      rules: [{ id: RULE_A, isActive: false, targetTeamId: null, targetUserId: null }],
    });

    await expect(rules.update(RULE_A, { name: 'Renamed' })).resolves.toBeDefined();
  });

  it('refuses an edit that resubmits a tag id that has since been deleted', async () => {
    // The realistic path to a dead reference, and the one the write check exists
    // for: the supervisor is renaming the rule, and the console sends the whole
    // condition list back — including a tag somebody removed in the meantime.
    const { rules } = buildWorld({ rules: [{ id: RULE_A }], teams: [TEAM], tags: [] });

    await expect(
      rules.update(RULE_A, {
        name: 'Renamed',
        conditions: [{ type: 'tag', match: 'any', tagIds: [TAG] }],
      }),
    ).rejects.toThrow(UnknownRuleReferenceError);
  });

  it('is a not-found for a rule this tenant cannot see', async () => {
    const { rules } = buildWorld();

    await expect(rules.update(RULE_A, { name: 'x' })).rejects.toThrow(AssignmentRuleNotFoundError);
  });

  describe('moving one rule with `position`', () => {
    it('shifts the rules it steps over on the way down', async () => {
      const { rules, recorded } = buildWorld({ rules: [{ id: RULE_A, position: 1 }] });

      await rules.update(RULE_A, { position: 4 });

      expect(recorded.updatedMany[0]?.where).toMatchObject({
        id: { not: RULE_A },
        position: { gt: 1, lte: 4 },
      });
      expect(recorded.updatedMany[0]?.data).toEqual({ position: { decrement: 1 } });
    });

    it('shifts them the other way on the way up', async () => {
      const { rules, recorded } = buildWorld({ rules: [{ id: RULE_A, position: 4 }] });

      await rules.update(RULE_A, { position: 1 });

      expect(recorded.updatedMany[0]?.where).toMatchObject({
        id: { not: RULE_A },
        position: { gte: 1, lt: 4 },
      });
      expect(recorded.updatedMany[0]?.data).toEqual({ position: { increment: 1 } });
    });

    it('shifts nothing when the position does not change', async () => {
      const { rules, recorded } = buildWorld({ rules: [{ id: RULE_A, position: 2 }] });

      await rules.update(RULE_A, { position: 2 });

      expect(recorded.updatedMany).toHaveLength(0);
    });
  });
});

describe('deleting a rule', () => {
  it('is idempotent: deleting one that is already gone is not an error', async () => {
    const { rules, recorded } = buildWorld();

    await expect(rules.delete(RULE_A)).resolves.toBeUndefined();
    expect(recorded.deleted).toHaveLength(0);
    // And nothing is audited, because nothing happened.
    expect(recorded.audited).toHaveLength(0);
  });

  it('audits the one it actually deleted', async () => {
    const { rules, recorded } = buildWorld({ rules: [{ id: RULE_A }] });

    await rules.delete(RULE_A);

    expect(recorded.deleted).toEqual([RULE_A]);
    expect(recorded.audited).toEqual(['assignment_rule.deleted']);
  });
});

describe('reordering', () => {
  it('rewrites every position to its index in the submitted order', async () => {
    const { rules, recorded } = buildWorld({
      rules: [
        { id: RULE_A, position: 0 },
        { id: RULE_B, position: 1 },
      ],
    });

    await rules.reorder({ ruleIds: [RULE_B, RULE_A] });

    expect(recorded.updatedMany).toEqual([
      { where: { id: RULE_B }, data: { position: 0 } },
      { where: { id: RULE_A }, data: { position: 1 } },
    ]);
  });

  it('refuses a set that is missing a rule the tenant holds', async () => {
    // Optimistic concurrency, for free: a set that is not exactly the current
    // one means another supervisor added or deleted a rule since this client
    // loaded the page, and a silent partial reorder would be worse than a 409.
    const { rules } = buildWorld({
      rules: [
        { id: RULE_A, position: 0 },
        { id: RULE_B, position: 1 },
      ],
    });

    await expect(rules.reorder({ ruleIds: [RULE_A] })).rejects.toThrow(RuleSetChangedError);
  });

  it('refuses a set naming a rule the tenant does not hold', async () => {
    const { rules } = buildWorld({ rules: [{ id: RULE_A, position: 0 }] });

    await expect(rules.reorder({ ruleIds: [RULE_B] })).rejects.toThrow(RuleSetChangedError);
  });

  it('refuses a duplicated id rather than reordering half the list', async () => {
    // The schema caps the array's length and does not assert uniqueness, so
    // `[A, A]` against a two-rule tenant has the right length and the wrong
    // contents.
    const { rules } = buildWorld({
      rules: [
        { id: RULE_A, position: 0 },
        { id: RULE_B, position: 1 },
      ],
    });

    await expect(rules.reorder({ ruleIds: [RULE_A, RULE_A] })).rejects.toThrow(RuleSetChangedError);
  });
});
