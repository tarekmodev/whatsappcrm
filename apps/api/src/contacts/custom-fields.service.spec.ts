import { CUSTOM_FIELD_LIMITS, type RoutingCondition } from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import {
  CustomFieldInUseByRulesError,
  CustomFieldNotFoundError,
  CustomFieldOptionsMismatchError,
  CustomFieldSetChangedError,
  TooManyCustomFieldsError,
} from './contacts.errors';
import { CustomFieldsService } from './custom-fields.service';

/**
 * The definition-writing invariants that do not need a database to state.
 *
 * The ones that do — RLS, the `(tenant_id, key)` unique index, and whether the
 * value strip actually reaches other tenants' rows — are in
 * `contacts-tenant-isolation.int-spec.ts`, because asserting them against a fake
 * would only prove the fake agrees with itself.
 *
 * Fake transaction rather than jest mocks, matching `assignment-rules.service.spec.ts`:
 * the real service body runs, so the order of the checks and the statements it
 * issues are what is under test.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000b1';
const FIELD_A = '0192f0ff-0000-7000-8000-00000000c001';
const FIELD_B = '0192f0ff-0000-7000-8000-00000000c002';
const RULE = '0192f0ff-0000-7000-8000-00000000r001';

interface FieldRow {
  id: string;
  key: string;
  label: string;
  type: string;
  options: unknown;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

interface RuleRow {
  id: string;
  name: string;
  conditions: RoutingCondition[];
}

interface WorldOptions {
  fields?: Partial<FieldRow>[];
  rules?: RuleRow[];
}

interface Recorded {
  created: Record<string, unknown>[];
  updated: { where: Record<string, unknown>; data: Record<string, unknown> }[];
  updatedMany: { where: Record<string, unknown>; data: Record<string, unknown> }[];
  deleted: string[];
  /** The raw statements the service issued, joined back into readable SQL. */
  raw: { sql: string; values: unknown[] }[];
  audited: string[];
}

function fieldRow(overrides: Partial<FieldRow> = {}): FieldRow {
  return {
    id: FIELD_A,
    key: 'tier',
    label: 'Account tier',
    type: 'text',
    options: [],
    position: 0,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildWorld(options: WorldOptions = {}): {
  customFields: CustomFieldsService;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    created: [],
    updated: [],
    updatedMany: [],
    deleted: [],
    raw: [],
    audited: [],
  };
  const rows = (options.fields ?? []).map(fieldRow);

  const tx = {
    customFieldDef: {
      count: () => Promise.resolve(rows.length),
      aggregate: () =>
        Promise.resolve({
          _max: {
            position: rows.length === 0 ? null : Math.max(...rows.map((row) => row.position)),
          },
        }),
      findMany: () => Promise.resolve(rows),
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        recorded.created.push(data);
        return Promise.resolve(fieldRow(data as Partial<FieldRow>));
      },
      update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        recorded.updated.push(args);
        return Promise.resolve(fieldRow(args.data as Partial<FieldRow>));
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
    assignmentRule: {
      // Tenant-scoped in the real query, and the fake honours that by listing
      // only this tenant's rules: another tenant's is simply absent.
      findMany: () => Promise.resolve(options.rules ?? []),
    },
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.raw.push({ sql: strings.join('?'), values });
      return Promise.resolve(0);
    },
  };

  const prisma = {
    customFieldDef: tx.customFieldDef,
    $tenantTransaction: <T>(work: (client: unknown) => Promise<T>) => work(tx),
  } as unknown as TenantPrisma;

  const tenantContext = { requireTenantId: () => TENANT } as unknown as TenantContextService;

  const audit = {
    record: (_tx: unknown, entry: { action: string }) => {
      recorded.audited.push(entry.action);
      return Promise.resolve();
    },
  } as unknown as AuditService;

  return {
    customFields: new CustomFieldsService(prisma, tenantContext, audit),
    recorded,
  };
}

describe('defining a custom field', () => {
  it('assigns position server-side, appending last', () => {
    // A client-supplied position is a race between two admins, so `POST` does
    // not accept one and `PATCH` does not accept one at all.
    const { customFields, recorded } = buildWorld({
      fields: [
        { id: FIELD_A, position: 0 },
        { id: FIELD_B, position: 4 },
      ],
    });

    return customFields
      .create({ key: 'tier', label: 'Account tier', type: 'text', options: [] })
      .then(() => {
        expect(recorded.created[0]?.position).toBe(5);
      });
  });

  it('starts at zero for the tenant’s first field', async () => {
    const { customFields, recorded } = buildWorld();

    await customFields.create({ key: 'tier', label: 'Account tier', type: 'text', options: [] });

    expect(recorded.created[0]?.position).toBe(0);
  });

  it('refuses the definition that would take the tenant past the cap', async () => {
    // `conflict`, not `plan_limit_exceeded`: the cap keeps the list unpaginated
    // and is not something money can fix.
    const { customFields } = buildWorld({
      fields: Array.from({ length: CUSTOM_FIELD_LIMITS.definitionsPerTenant }, (_, index) => ({
        id: FIELD_A,
        position: index,
      })),
    });

    await expect(
      customFields.create({ key: 'tier', label: 'Account tier', type: 'text', options: [] }),
    ).rejects.toThrow(TooManyCustomFieldsError);
  });

  it('audits the write, because it changes the shape of every contact record', async () => {
    const { customFields, recorded } = buildWorld();

    await customFields.create({ key: 'tier', label: 'Account tier', type: 'text', options: [] });

    expect(recorded.audited).toEqual(['custom_field.created']);
  });
});

describe('editing a definition', () => {
  it('renames the label without touching key or type', async () => {
    // `key` and `type` are refused by the schema rather than here — this asserts
    // the service writes only what it was given.
    const { customFields, recorded } = buildWorld({ fields: [{ id: FIELD_A }] });

    await customFields.update(FIELD_A, { label: 'Tier' });

    expect(recorded.updated[0]?.data).toEqual({ label: 'Tier' });
  });

  it('refuses options on a field that is not a select', async () => {
    const { customFields } = buildWorld({ fields: [{ id: FIELD_A, type: 'text' }] });

    await expect(customFields.update(FIELD_A, { options: ['gold'] })).rejects.toThrow(
      CustomFieldOptionsMismatchError,
    );
  });

  it('refuses emptying a select’s options, which would leave it unfillable', async () => {
    const { customFields } = buildWorld({
      fields: [{ id: FIELD_A, type: 'select', options: ['gold'] }],
    });

    await expect(customFields.update(FIELD_A, { options: [] })).rejects.toThrow(
      CustomFieldOptionsMismatchError,
    );
  });

  it('allows removing one option from a select, and rewrites no contact', async () => {
    // A stored value outside the current options survives until that field is
    // next written. Refusing the removal would need a scan of the tenant's
    // contacts to protect data the admin has just said they no longer want.
    const { customFields, recorded } = buildWorld({
      fields: [{ id: FIELD_A, type: 'select', options: ['gold', 'silver'] }],
    });

    await customFields.update(FIELD_A, { options: ['gold'] });

    expect(recorded.raw).toEqual([]);
  });

  it('is not found when the id names no field in this tenant', async () => {
    // Another tenant's field is invisible under RLS, so this is the same answer
    // for "deleted" and "somebody else's" — deliberately indistinguishable.
    const { customFields } = buildWorld();

    await expect(customFields.update(FIELD_A, { label: 'Tier' })).rejects.toThrow(
      CustomFieldNotFoundError,
    );
  });
});

describe('deleting a definition', () => {
  it('strips the key from the tenant’s contacts in the same transaction', async () => {
    // The alternative — leaving values orphaned — means an admin who deletes
    // `national_id` and re-creates the key gets every old value back.
    const { customFields, recorded } = buildWorld({ fields: [{ id: FIELD_A, key: 'tier' }] });

    await customFields.delete(FIELD_A);

    expect(recorded.deleted).toEqual([FIELD_A]);
    expect(recorded.raw).toHaveLength(1);
    expect(recorded.raw[0]?.values).toEqual(['tier', TENANT, 'tier']);
  });

  it('guards the strip against a custom_fields column that is not an object', async () => {
    // `custom_fields - 'key'` removes an *element* from an array and raises on a
    // scalar, so one row written by hand would turn a settings action into a 500.
    const { customFields, recorded } = buildWorld({ fields: [{ id: FIELD_A, key: 'tier' }] });

    await customFields.delete(FIELD_A);

    expect(recorded.raw[0]?.sql).toContain("jsonb_typeof(custom_fields) = 'object'");
  });

  it('refuses while a routing rule names the key, and names the rules', async () => {
    // A rule whose condition can never match again is routing that quietly
    // matches nothing, which looks exactly like routing that works.
    const { customFields, recorded } = buildWorld({
      fields: [{ id: FIELD_A, key: 'tier' }],
      rules: [
        {
          id: RULE,
          name: 'Gold to Billing',
          conditions: [{ type: 'contact_attribute', key: 'tier', operator: 'is_set', value: null }],
        },
      ],
    });

    await expect(customFields.delete(FIELD_A)).rejects.toThrow(CustomFieldInUseByRulesError);
    // Refused *before* anything was written, so the rollback is not load-bearing.
    expect(recorded.deleted).toEqual([]);
    expect(recorded.raw).toEqual([]);
  });

  it('ignores a rule that names a different key', async () => {
    const { customFields } = buildWorld({
      fields: [{ id: FIELD_A, key: 'tier' }],
      rules: [
        {
          id: RULE,
          name: 'By plan',
          conditions: [{ type: 'contact_attribute', key: 'plan', operator: 'is_set', value: null }],
        },
      ],
    });

    await expect(customFields.delete(FIELD_A)).resolves.toBeUndefined();
  });

  it('is not found for an unknown id, rather than a silent 204', async () => {
    // Unlike a rule delete, this one has a second effect. Reporting success for
    // an id nothing looked at would claim the tenant's values under that key are
    // gone when nothing was examined.
    const { customFields } = buildWorld();

    await expect(customFields.delete(FIELD_A)).rejects.toThrow(CustomFieldNotFoundError);
  });
});

describe('reordering', () => {
  it('rewrites position to the submitted index', async () => {
    const { customFields, recorded } = buildWorld({
      fields: [
        { id: FIELD_A, position: 0 },
        { id: FIELD_B, position: 1 },
      ],
    });

    await customFields.reorder({ customFieldIds: [FIELD_B, FIELD_A] });

    expect(recorded.updatedMany).toEqual([
      { where: { id: FIELD_B }, data: { position: 0 } },
      { where: { id: FIELD_A }, data: { position: 1 } },
    ]);
  });

  it('refuses a set that is not the tenant’s current one', async () => {
    // The whole set rather than a delta buys optimistic concurrency: a mismatch
    // means another admin added or deleted a field since this client loaded.
    const { customFields } = buildWorld({
      fields: [
        { id: FIELD_A, position: 0 },
        { id: FIELD_B, position: 1 },
      ],
    });

    await expect(customFields.reorder({ customFieldIds: [FIELD_A] })).rejects.toThrow(
      CustomFieldSetChangedError,
    );
  });

  it('refuses a set that repeats one id and omits another', async () => {
    // The schema caps the array's length and does not assert uniqueness, so
    // without this it would reorder half the list.
    const { customFields } = buildWorld({
      fields: [
        { id: FIELD_A, position: 0 },
        { id: FIELD_B, position: 1 },
      ],
    });

    await expect(customFields.reorder({ customFieldIds: [FIELD_A, FIELD_A] })).rejects.toThrow(
      CustomFieldSetChangedError,
    );
  });
});
