import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { UnknownTagError } from '../tags/tags.errors';
import { ContactsService } from './contacts.service';
import { ContactNotFoundError, CustomFieldValuesInvalidError } from './contacts.errors';

/**
 * The contact-writing invariants that do not need a database to state: what a
 * `tagIds` write does to the join rows, what a `customFields` write does to the
 * stored map, and which references are refused before anything is written.
 *
 * Isolation itself is in `contacts-tenant-isolation.int-spec.ts` — it depends on
 * the GUC, on TAR-48's policies and on composite foreign keys, none of which a
 * fake has.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000b1';
const CONTACT = '0192f0ff-0000-7000-8000-00000000e001';
const VIP = '0192f0ff-0000-7000-8000-00000000a001';
const LEAD = '0192f0ff-0000-7000-8000-00000000a002';
/** Deleted, or another tenant's — indistinguishable from here, and deliberately so. */
const FOREIGN_TAG = '0192f0ff-0000-7000-8000-00000000a999';

interface WorldOptions {
  /** Contacts that exist in this tenant, by id. */
  contact?: { customFields: unknown; tagIds: string[] } | null;
  tags?: string[];
  customFieldKeys?: { key: string; type: string; options: string[] }[];
}

interface Recorded {
  created: Record<string, unknown>[];
  updated: Record<string, unknown>[];
  tagsAdded: { tagId: string }[];
  tagsRemoved: { tagId: { in: string[] } }[];
  /** Raw statements, so the row lock can be asserted on. */
  raw: { sql: string; values: unknown[] }[];
  /**
   * `lock` and `read` in the order they happened. Which statement comes *first*
   * is the whole point of the lock — see `lockContact` — and only an ordering
   * assertion can state it.
   */
  order: ('lock' | 'read')[];
}

function buildWorld(options: WorldOptions = {}): {
  contacts: ContactsService;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    created: [],
    updated: [],
    tagsAdded: [],
    tagsRemoved: [],
    raw: [],
    order: [],
  };
  const stored = options.contact ?? null;

  const contactRow = {
    id: CONTACT,
    phoneE164: '+966501234567',
    displayName: 'Layla',
    email: null,
    customFields: stored?.customFields ?? {},
    lastSeenAt: null,
    optedOutAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    tags: [],
  };

  const tx = {
    $queryRaw: (fragments: TemplateStringsArray, ...values: unknown[]) => {
      recorded.raw.push({ sql: fragments.join('?'), values });
      recorded.order.push('lock');
      return Promise.resolve([]);
    },
    contact: {
      findUnique: () => {
        recorded.order.push('read');

        return Promise.resolve(
          stored === null
            ? null
            : {
                id: CONTACT,
                customFields: stored.customFields,
                tags: stored.tagIds.map((tagId) => ({ tagId })),
              },
        );
      },
      findUniqueOrThrow: () => Promise.resolve(contactRow),
      create: ({ data }: { data: Record<string, unknown> }) => {
        recorded.created.push(data);
        return Promise.resolve({ id: CONTACT });
      },
      update: ({ data }: { data: Record<string, unknown> }) => {
        recorded.updated.push(data);
        return Promise.resolve({ id: CONTACT });
      },
    },
    contactTag: {
      createMany: ({ data }: { data: { tagId: string }[] }) => {
        recorded.tagsAdded.push(...data);
        return Promise.resolve({ count: data.length });
      },
      deleteMany: ({ where }: { where: { tagId: { in: string[] } } }) => {
        recorded.tagsRemoved.push(where);
        return Promise.resolve({ count: where.tagId.in.length });
      },
    },
    tag: {
      // Tenant-scoped in the real query, and the fake honours that: an id
      // belonging to anyone else is simply absent.
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.filter((id) => (options.tags ?? []).includes(id)).map((id) => ({ id })),
        ),
    },
    customFieldDef: {
      findMany: () =>
        Promise.resolve(
          (options.customFieldKeys ?? []).map((field, index) => ({
            id: `0192f0ff-0000-7000-8000-00000000c00${String(index + 1)}`,
            key: field.key,
            label: field.key,
            type: field.type,
            options: field.options,
            position: index,
            createdAt: new Date('2026-08-01T00:00:00.000Z'),
            updatedAt: new Date('2026-08-01T00:00:00.000Z'),
          })),
        ),
    },
  };

  const prisma = {
    contact: tx.contact,
    $tenantTransaction: <T>(work: (client: unknown) => Promise<T>) => work(tx),
  } as unknown as TenantPrisma;

  const tenantContext = { requireTenantId: () => TENANT } as unknown as TenantContextService;

  return { contacts: new ContactsService(prisma, tenantContext), recorded };
}

const TIER = { key: 'tier', type: 'text', options: [] };

describe('creating a contact', () => {
  it('writes the tags it was given, carrying the tenant on every join row', async () => {
    // `tenant_id` on `contact_tags` is half of what makes the boundary hold —
    // the composite keys reach both parents through it.
    const { contacts, recorded } = buildWorld({ tags: [VIP] });

    await contacts.create({ phone: '+966501234567', displayName: 'Layla', tagIds: [VIP] });

    expect(recorded.tagsAdded).toEqual([{ tenantId: TENANT, contactId: CONTACT, tagId: VIP }]);
  });

  it('refuses a tag that is not in this tenant, before writing the contact', async () => {
    const { contacts, recorded } = buildWorld({ tags: [VIP] });

    await expect(
      contacts.create({ phone: '+966501234567', displayName: 'Layla', tagIds: [FOREIGN_TAG] }),
    ).rejects.toThrow(UnknownTagError);
    expect(recorded.created).toEqual([]);
  });

  it('validates custom field values against the tenant’s definitions', async () => {
    const { contacts } = buildWorld({ tags: [], customFieldKeys: [TIER] });

    await expect(
      contacts.create({
        phone: '+966501234567',
        displayName: 'Layla',
        tagIds: [],
        customFields: { teir: 'gold' },
      }),
    ).rejects.toThrow(CustomFieldValuesInvalidError);
  });
});

describe('updating a contact', () => {
  /**
   * TAR-530. The merge is computed in JavaScript from a row read earlier in the
   * same transaction, so under `READ COMMITTED` the read has to hold the row —
   * otherwise two agents editing different keys both read the same map and the
   * second write drops the first one's key.
   *
   * What this states is the *ordering*: lock, then read. That the lock actually
   * serialises two transactions is
   * `contact-custom-field-concurrency.int-spec.ts`, which needs a real database.
   */
  it('locks the contact row before reading it', async () => {
    const { contacts, recorded } = buildWorld({
      contact: { customFields: { tier: 'gold' }, tagIds: [] },
      customFieldKeys: [TIER],
    });

    await contacts.update(CONTACT, { customFields: { tier: 'silver' } });

    expect(recorded.order).toEqual(['lock', 'read']);
    // `FOR NO KEY UPDATE`, not `FOR UPDATE`: it excludes every writer that
    // matters while still letting a conversation or ticket insert take its
    // `FOR KEY SHARE` on the contact — see `lockContact`.
    expect(recorded.raw[0]?.sql).toContain('FOR NO KEY UPDATE');
    // The tenant predicate alongside the id: RLS is the guarantee, and this is
    // the same belt-and-braces `stripValues` writes for the same reason.
    expect(recorded.raw[0]?.values).toEqual([TENANT, CONTACT]);
  });

  it('takes no row lock on a create, which has no row to read', async () => {
    const { contacts, recorded } = buildWorld({ tags: [] });

    await contacts.create({ phone: '+966501234567', displayName: 'Layla', tagIds: [] });

    expect(recorded.raw).toEqual([]);
  });

  it('merges custom fields rather than replacing them', async () => {
    // The decision amendment 10 names: replacement would make an agent editing
    // one field erase every value their form did not load.
    const { contacts, recorded } = buildWorld({
      contact: { customFields: { tier: 'gold', seats: '4' }, tagIds: [] },
      customFieldKeys: [TIER, { key: 'seats', type: 'number', options: [] }],
    });

    await contacts.update(CONTACT, { customFields: { tier: 'silver' } });

    expect(recorded.updated[0]?.customFields).toEqual({ tier: 'silver', seats: '4' });
  });

  it('leaves stored values alone when the write carries no customFields at all', async () => {
    const { contacts, recorded } = buildWorld({
      contact: { customFields: { tier: 'gold' }, tagIds: [] },
      customFieldKeys: [TIER],
    });

    await contacts.update(CONTACT, { displayName: 'Layla A.' });

    expect(recorded.updated[0]).toEqual({ displayName: 'Layla A.' });
  });

  it('replaces the tag set, adding and removing only the difference', async () => {
    // `tagIds` is the set the console sees whole on the screen it is editing, so
    // this is the assign-and-remove route — unlike `customFields`, which merges.
    const { contacts, recorded } = buildWorld({
      contact: { customFields: {}, tagIds: [VIP] },
      tags: [VIP, LEAD],
    });

    await contacts.update(CONTACT, { tagIds: [LEAD] });

    expect(recorded.tagsAdded).toEqual([{ tenantId: TENANT, contactId: CONTACT, tagId: LEAD }]);
    expect(recorded.tagsRemoved).toEqual([{ contactId: CONTACT, tagId: { in: [VIP] } }]);
  });

  it('removes every tag when given an empty set', async () => {
    const { contacts, recorded } = buildWorld({
      contact: { customFields: {}, tagIds: [VIP] },
      tags: [VIP],
    });

    await contacts.update(CONTACT, { tagIds: [] });

    expect(recorded.tagsRemoved).toEqual([{ contactId: CONTACT, tagId: { in: [VIP] } }]);
    expect(recorded.tagsAdded).toEqual([]);
  });

  it('refuses a foreign tag before touching the contact’s existing ones', async () => {
    const { contacts, recorded } = buildWorld({
      contact: { customFields: {}, tagIds: [VIP] },
      tags: [VIP],
    });

    await expect(contacts.update(CONTACT, { tagIds: [FOREIGN_TAG] })).rejects.toThrow(
      UnknownTagError,
    );
    expect(recorded.tagsRemoved).toEqual([]);
    expect(recorded.updated).toEqual([]);
  });

  it('is not found when the id names no contact in this tenant', async () => {
    const { contacts } = buildWorld({ contact: null });

    await expect(contacts.update(CONTACT, { displayName: 'Layla' })).rejects.toThrow(
      ContactNotFoundError,
    );
  });
});
