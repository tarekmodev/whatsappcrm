import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  ContactResponse,
  CursorPage,
  CustomFieldDefinition,
  CustomFieldDefinitionListResponse,
  Tag,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';

/**
 * TAR-479's fourth and fifth acceptance criteria — **no contact, tag or custom
 * field definition leaks across tenants under any role**, asserted explicitly
 * rather than left to "happen to scope correctly" — plus the CRUD paths end to
 * end against a real PostgreSQL and the real request pipeline.
 *
 * Isolation is not a claim a unit test can make. It depends on the GUC being set
 * on the same connection as the statement, on TAR-48's policies, on composite
 * foreign keys refusing a reference the policy would have allowed, and — for the
 * value strip — on a raw `UPDATE` being filtered by all of it. None of that a
 * fake has.
 *
 * So every case runs against two tenants whose fixtures are deliberately
 * **identical in shape**: both have a contact, both have a tag named `VIP`, and
 * both have a custom field keyed `tier` with a value stored under it. If any
 * part of this surface leaked, the two would be indistinguishable and the
 * assertions would pass by accident — so the ids differ and the assertions name
 * them.
 *
 * The two axes are the host (which tenant) and the role (which permission), the
 * same pair `people-rbac.int-spec.ts` and `routing-rules.int-spec.ts` vary. The
 * role comes from the interim stub, which changes *who* the principal is; every
 * guard, policy and predicate under test is the real one.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids, deleted before the run as well as after, so an interrupted
 * run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '88888888-0000-7000-8000-000000000101';
const TENANT_B = '88888888-0000-7000-8000-000000000102';
const HOST_A = 'tar479-a.app.localhost';
const HOST_B = 'tar479-b.app.localhost';

const ADMIN_A = '88888888-0000-7000-8000-0000000001a1';
const SUPERVISOR_A = '88888888-0000-7000-8000-0000000001a2';
const AGENT_A = '88888888-0000-7000-8000-0000000001a3';
const ADMIN_B = '88888888-0000-7000-8000-0000000001b1';

const CONTACT_A = '88888888-0000-7000-8000-0000000002a1';
const CONTACT_B = '88888888-0000-7000-8000-0000000002b1';
const VIP_A = '88888888-0000-7000-8000-0000000003a1';
const LEAD_A = '88888888-0000-7000-8000-0000000003a2';
const VIP_B = '88888888-0000-7000-8000-0000000003b1';
const TIER_A = '88888888-0000-7000-8000-0000000004a1';
const TIER_B = '88888888-0000-7000-8000-0000000004b1';

type Role = 'agent' | 'supervisor' | 'admin';

/** `supertest` types a body as `any`. These readers are where that stops. */
const errorCodeOf = (response: request.Response): string =>
  (response.body as { error: { code: string } }).error.code;

const contactOf = (response: request.Response): ContactResponse => response.body as ContactResponse;

const contactPageOf = (response: request.Response): CursorPage<ContactResponse> =>
  response.body as CursorPage<ContactResponse>;

const tagPageOf = (response: request.Response): CursorPage<Tag> => response.body as CursorPage<Tag>;

const definitionListOf = (response: request.Response): CustomFieldDefinitionListResponse =>
  response.body as CustomFieldDefinitionListResponse;

const definitionOf = (response: request.Response): CustomFieldDefinition =>
  response.body as CustomFieldDefinition;

describe('contacts, tags and custom fields across two tenants', () => {
  let app: INestApplication;
  let systemPrisma: PrismaClient;

  /** One request as `role`, at `host`. The two axes every case below varies. */
  function call(host: string, role: Role) {
    return request
      .agent(app.getHttpServer() as Server)
      .set('Host', host)
      .set('x-dev-role', role);
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  async function seed(): Promise<void> {
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar479-fixture-a', name: 'TAR-479 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar479-fixture-b', name: 'TAR-479 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.tenantDomain.createMany({
      data: [
        {
          tenantId: TENANT_A,
          hostname: HOST_A,
          kind: 'platform',
          isPrimary: true,
          verifiedAt: new Date(),
        },
        {
          tenantId: TENANT_B,
          hostname: HOST_B,
          kind: 'platform',
          isPrimary: true,
          verifiedAt: new Date(),
        },
      ],
    });
    await systemPrisma.tenantSettings.createMany({
      data: [
        { tenantId: TENANT_A, timezone: 'Europe/London' },
        { tenantId: TENANT_B, timezone: 'Europe/London' },
      ],
    });
    await systemPrisma.user.createMany({
      data: [
        {
          id: ADMIN_A,
          tenantId: TENANT_A,
          email: 'admin@tar479-a.invalid',
          name: 'A Admin',
          role: 'admin',
          status: 'active',
        },
        {
          id: SUPERVISOR_A,
          tenantId: TENANT_A,
          email: 'super@tar479-a.invalid',
          name: 'A Supervisor',
          role: 'supervisor',
          status: 'active',
        },
        {
          id: AGENT_A,
          tenantId: TENANT_A,
          email: 'agent@tar479-a.invalid',
          name: 'A Agent',
          role: 'agent',
          status: 'active',
        },
        {
          id: ADMIN_B,
          tenantId: TENANT_B,
          email: 'admin@tar479-b.invalid',
          name: 'B Admin',
          role: 'admin',
          status: 'active',
        },
      ],
    });
  }

  /**
   * The tenant-scoped rows, re-created before every test so the cases pass in
   * any order — several of them delete or rewrite what they touch.
   *
   * Deliberately identical in shape across the two tenants: same tag name, same
   * custom field key, same stored value. That is what makes a leak visible
   * rather than plausible.
   */
  async function seedContacts(): Promise<void> {
    await systemPrisma.contactTag.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.contact.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.tag.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.customFieldDef.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.assignmentRule.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.auditLog.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });

    await systemPrisma.tag.createMany({
      data: [
        { id: VIP_A, tenantId: TENANT_A, name: 'VIP', color: '#112233' },
        { id: LEAD_A, tenantId: TENANT_A, name: 'Lead', color: null },
        // Same name, other tenant. If any read leaked, the two would be
        // indistinguishable — which is why the assertions name the ids.
        { id: VIP_B, tenantId: TENANT_B, name: 'VIP', color: '#445566' },
      ],
    });
    await systemPrisma.customFieldDef.createMany({
      data: [
        { id: TIER_A, tenantId: TENANT_A, key: 'tier', label: 'Account tier', position: 0 },
        { id: TIER_B, tenantId: TENANT_B, key: 'tier', label: 'Account tier', position: 0 },
      ],
    });
    await systemPrisma.contact.createMany({
      data: [
        {
          id: CONTACT_A,
          tenantId: TENANT_A,
          phoneE164: '+10000047901',
          displayName: 'Layla',
          customFields: { tier: 'gold' },
        },
        {
          id: CONTACT_B,
          tenantId: TENANT_B,
          phoneE164: '+10000047902',
          displayName: 'Layla',
          customFields: { tier: 'gold' },
        },
      ],
    });
    await systemPrisma.contactTag.createMany({
      data: [
        { tenantId: TENANT_A, contactId: CONTACT_A, tagId: VIP_A },
        { tenantId: TENANT_B, contactId: CONTACT_B, tagId: VIP_B },
      ],
    });
  }

  beforeAll(async () => {
    // The stub is what supplies a role before TAR-35, and it has to be set
    // before `app.module` is *loaded* — `ConfigModule.forRoot()` reads the
    // environment the moment the file is imported. Hence the dynamic import.
    process.env.AUTH_STUB_ENABLED = 'true';

    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    await removeFixture();
    await seed();

    const { AppModule } = await import('../app.module');

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    configureApp(app);
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await removeFixture();
    await systemPrisma.$disconnect();
  });

  beforeEach(seedContacts);

  describe('the contact surface', () => {
    it('lists only this tenant’s contacts', async () => {
      const response = await call(HOST_A, 'agent').get('/api/v1/contacts');

      expect(response.status).toBe(200);
      expect(contactPageOf(response).items.map((contact) => contact.id)).toEqual([CONTACT_A]);
    });

    it('embeds only this tenant’s tag on a contact, not the identically named one', async () => {
      const response = await call(HOST_A, 'agent').get(`/api/v1/contacts/${CONTACT_A}`);

      expect(contactOf(response).tags.map((tag) => tag.id)).toEqual([VIP_A]);
    });

    it.each<Role>(['agent', 'supervisor', 'admin'])(
      'answers not_found for another tenant’s contact as %s',
      async (role) => {
        // `not_found`, never `forbidden`: a 403 would confirm the id exists
        // somewhere. Admin is in this list on purpose — the widest role in the
        // tenant is still bounded by the tenant.
        const response = await call(HOST_A, role).get(`/api/v1/contacts/${CONTACT_B}`);

        expect(response.status).toBe(404);
        expect(errorCodeOf(response)).toBe('not_found');
      },
    );

    it('refuses to patch another tenant’s contact, and leaves it untouched', async () => {
      const response = await call(HOST_A, 'admin')
        .patch(`/api/v1/contacts/${CONTACT_B}`)
        .send({ displayName: 'Taken over' });

      expect(response.status).toBe(404);

      const untouched = await systemPrisma.contact.findUniqueOrThrow({ where: { id: CONTACT_B } });

      expect(untouched.displayName).toBe('Layla');
    });

    it('refuses another tenant’s tag on its own contact, and writes nothing', async () => {
      // The composite key `(tenant_id, tag_id)` is what actually refuses this;
      // the check turns it into `validation_failed` naming the field.
      const response = await call(HOST_A, 'agent')
        .patch(`/api/v1/contacts/${CONTACT_A}`)
        .send({ tagIds: [VIP_B] });

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');

      const held = await systemPrisma.contactTag.findMany({ where: { contactId: CONTACT_A } });

      expect(held.map((row) => row.tagId)).toEqual([VIP_A]);
    });

    it('filters by tag, and another tenant’s tag id matches nothing', async () => {
      const matching = await call(HOST_A, 'agent').get(`/api/v1/contacts?tagId=${VIP_A}`);
      const foreign = await call(HOST_A, 'agent').get(`/api/v1/contacts?tagId=${VIP_B}`);
      const other = await call(HOST_A, 'agent').get(`/api/v1/contacts?tagId=${LEAD_A}`);

      expect(contactPageOf(matching).items.map((contact) => contact.id)).toEqual([CONTACT_A]);
      expect(contactPageOf(foreign).items).toEqual([]);
      expect(contactPageOf(other).items).toEqual([]);
    });

    it('assigns and removes tags through the same write', async () => {
      const added = await call(HOST_A, 'agent')
        .patch(`/api/v1/contacts/${CONTACT_A}`)
        .send({ tagIds: [VIP_A, LEAD_A] });

      expect(
        contactOf(added)
          .tags.map((tag) => tag.id)
          .sort(),
      ).toEqual([VIP_A, LEAD_A].sort());

      const removed = await call(HOST_A, 'agent')
        .patch(`/api/v1/contacts/${CONTACT_A}`)
        .send({ tagIds: [] });

      expect(contactOf(removed).tags).toEqual([]);
    });

    it('merges custom field values across two writes rather than replacing them', async () => {
      await call(HOST_A, 'admin')
        .post('/api/v1/custom-fields')
        .send({ key: 'seats', label: 'Seats', type: 'number' });

      const response = await call(HOST_A, 'agent')
        .patch(`/api/v1/contacts/${CONTACT_A}`)
        .send({ customFields: { seats: '4' } });

      expect(contactOf(response).customFields).toEqual({ tier: 'gold', seats: '4' });
    });

    it('refuses a value that is not legal for its type, naming the key', async () => {
      const response = await call(HOST_A, 'agent')
        .patch(`/api/v1/contacts/${CONTACT_A}`)
        .send({ customFields: { tier: 'x'.repeat(501) } });

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
    });

    it('refuses a key defined only in the other tenant', async () => {
      // `tier` exists in both, so this uses a key only B has — the definition
      // list the merge validates against must be A's alone.
      await systemPrisma.customFieldDef.create({
        data: { tenantId: TENANT_B, key: 'region', label: 'Region' },
      });

      const response = await call(HOST_A, 'agent')
        .patch(`/api/v1/contacts/${CONTACT_A}`)
        .send({ customFields: { region: 'EMEA' } });

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
    });

    it('refuses a duplicate phone number in the same tenant, and allows it in the other', async () => {
      const duplicate = await call(HOST_A, 'agent')
        .post('/api/v1/contacts')
        .send({ phone: '+10000047901', displayName: 'Also Layla' });

      expect(duplicate.status).toBe(409);

      // The same number is free in B: `(tenant_id, phone_e164)` is what is
      // unique, not the number.
      const allowed = await call(HOST_B, 'admin')
        .post('/api/v1/contacts')
        .send({ phone: '+10000047901', displayName: 'B’s Layla' });

      expect(allowed.status).toBe(201);
    });
  });

  describe('the tag surface', () => {
    it('lists only this tenant’s tags, though both have a VIP', async () => {
      const response = await call(HOST_A, 'agent').get('/api/v1/tags');

      expect(
        tagPageOf(response)
          .items.map((tag) => tag.id)
          .sort(),
      ).toEqual([VIP_A, LEAD_A].sort());
    });

    it('gives a colourless tag the neutral default rather than dropping it', async () => {
      const response = await call(HOST_A, 'agent').get('/api/v1/tags');
      const lead = tagPageOf(response).items.find((tag) => tag.id === LEAD_A);

      expect(lead?.color).toBe('#64748b');
    });

    it('refuses a duplicate name, and allows the same name in the other tenant', async () => {
      // `(tenant_id, name)` is what is unique, not the name — so `Lead` is free
      // in B while `VIP` is taken in A.
      const duplicate = await call(HOST_A, 'agent').post('/api/v1/tags').send({ name: 'VIP' });

      expect(duplicate.status).toBe(409);
      expect(errorCodeOf(duplicate)).toBe('conflict');

      const allowed = await call(HOST_B, 'admin').post('/api/v1/tags').send({ name: 'Lead' });

      expect(allowed.status).toBe(201);
    });

    it('matches the name filter case-insensitively, which the column does not', async () => {
      // `tags.name` is plain `text` — unlike `teams.name`, which is `citext` —
      // so this asserts the query supplies what the column does not. The same
      // gap means `VIP` and `vip` are two distinct tags on create; raised for
      // the schema owner rather than papered over with an application-level
      // check the database would not hold.
      const response = await call(HOST_A, 'agent').get('/api/v1/tags?q=vip');

      expect(tagPageOf(response).items.map((tag) => tag.id)).toEqual([VIP_A]);
    });
  });

  describe('the custom field surface', () => {
    it('lists only this tenant’s definitions, though both are keyed tier', async () => {
      const response = await call(HOST_A, 'agent').get('/api/v1/custom-fields');

      expect(definitionListOf(response).items.map((field) => field.id)).toEqual([TIER_A]);
      expect(definitionListOf(response).nextCursor).toBeNull();
    });

    it.each<[Role, number]>([
      ['agent', 403],
      ['supervisor', 403],
      ['admin', 201],
    ])('%s creating a definition answers %i', async (role, status) => {
      // The story's first acceptance criterion, enforced. `contact:write` cannot
      // carry this — every agent holds it, which is the criterion inverted.
      const response = await call(HOST_A, role)
        .post('/api/v1/custom-fields')
        .send({ key: 'region', label: 'Region', type: 'text' });

      expect(response.status).toBe(status);
    });

    it('lets every role read the vocabulary, because they have to fill it in', async () => {
      const response = await call(HOST_A, 'agent').get('/api/v1/custom-fields');

      expect(response.status).toBe(200);
    });

    it('assigns position server-side and orders the list by it', async () => {
      await call(HOST_A, 'admin')
        .post('/api/v1/custom-fields')
        .send({ key: 'region', label: 'Region', type: 'text' });
      const created = await call(HOST_A, 'admin')
        .post('/api/v1/custom-fields')
        .send({ key: 'seats', label: 'Seats', type: 'number' });

      expect(definitionOf(created).position).toBe(2);

      const list = await call(HOST_A, 'admin').get('/api/v1/custom-fields');

      expect(definitionListOf(list).items.map((field) => field.key)).toEqual([
        'tier',
        'region',
        'seats',
      ]);
    });

    it.each<Role>(['agent', 'supervisor', 'admin'])(
      'refuses to patch another tenant’s definition as %s',
      async (role) => {
        const response = await call(HOST_A, role)
          .patch(`/api/v1/custom-fields/${TIER_B}`)
          .send({ label: 'Taken over' });

        // Agent and supervisor are stopped by the permission, admin by the
        // tenant boundary — and neither reaches B's row.
        expect([403, 404]).toContain(response.status);

        const untouched = await systemPrisma.customFieldDef.findUniqueOrThrow({
          where: { id: TIER_B },
        });

        expect(untouched.label).toBe('Account tier');
      },
    );

    it('refuses a duplicate key in the same tenant, and allows it in the other', async () => {
      const duplicate = await call(HOST_A, 'admin')
        .post('/api/v1/custom-fields')
        .send({ key: 'tier', label: 'Tier again', type: 'text' });

      expect(duplicate.status).toBe(409);
      expect(errorCodeOf(duplicate)).toBe('conflict');
    });

    it('refuses to delete another tenant’s definition, and strips nothing', async () => {
      const response = await call(HOST_A, 'admin').delete(`/api/v1/custom-fields/${TIER_B}`);

      expect(response.status).toBe(404);

      const survived = await systemPrisma.customFieldDef.findUnique({ where: { id: TIER_B } });
      const contact = await systemPrisma.contact.findUniqueOrThrow({ where: { id: CONTACT_B } });

      expect(survived).not.toBeNull();
      expect(contact.customFields).toEqual({ tier: 'gold' });
    });

    it('strips the key from this tenant’s contacts and leaves the other tenant’s alone', async () => {
      // The case this whole file exists for: the strip is a raw `UPDATE`, so it
      // is filtered by RLS and the explicit tenant predicate rather than by
      // Prisma's argument rewriting — and both tenants store a value under the
      // same key.
      const response = await call(HOST_A, 'admin').delete(`/api/v1/custom-fields/${TIER_A}`);

      expect(response.status).toBe(204);

      const stripped = await systemPrisma.contact.findUniqueOrThrow({ where: { id: CONTACT_A } });
      const untouched = await systemPrisma.contact.findUniqueOrThrow({ where: { id: CONTACT_B } });

      expect(stripped.customFields).toEqual({});
      expect(untouched.customFields).toEqual({ tier: 'gold' });
    });

    it('audits the delete, because it is the one action here with no undo', async () => {
      await call(HOST_A, 'admin').delete(`/api/v1/custom-fields/${TIER_A}`);

      const audited = await systemPrisma.auditLog.findMany({ where: { tenantId: TENANT_A } });

      expect(audited.map((row) => row.action)).toEqual(['custom_field.deleted']);
    });

    it('refuses the delete while a routing rule names the key', async () => {
      // Inactive, and that is the interesting case rather than a convenience:
      // `assignment_rules_active_has_one_target` refuses an active rule with no
      // target, and a *disabled* rule naming a deleted key is exactly the one
      // that would silently never match the day somebody switches it back on.
      await systemPrisma.assignmentRule.create({
        data: {
          tenantId: TENANT_A,
          name: 'Gold to Billing',
          isActive: false,
          conditions: [{ type: 'contact_attribute', key: 'tier', operator: 'is_set', value: null }],
        },
      });

      const response = await call(HOST_A, 'admin').delete(`/api/v1/custom-fields/${TIER_A}`);

      expect(response.status).toBe(409);
      expect(errorCodeOf(response)).toBe('conflict');

      const survived = await systemPrisma.contact.findUniqueOrThrow({ where: { id: CONTACT_A } });

      expect(survived.customFields).toEqual({ tier: 'gold' });
    });

    it('refuses a reorder naming another tenant’s definition', async () => {
      const response = await call(HOST_A, 'admin')
        .post('/api/v1/custom-fields/reorder')
        .send({ customFieldIds: [TIER_B] });

      expect(response.status).toBe(409);
      expect(errorCodeOf(response)).toBe('conflict');
    });

    it('reorders this tenant’s definitions', async () => {
      await call(HOST_A, 'admin')
        .post('/api/v1/custom-fields')
        .send({ key: 'region', label: 'Region', type: 'text' });

      const list = await call(HOST_A, 'admin').get('/api/v1/custom-fields');
      const ids = definitionListOf(list).items.map((field) => field.id);

      const response = await call(HOST_A, 'admin')
        .post('/api/v1/custom-fields/reorder')
        .send({ customFieldIds: [...ids].reverse() });

      expect(response.status).toBe(200);
      expect(definitionListOf(response).items.map((field) => field.id)).toEqual([...ids].reverse());
    });
  });
});

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(`${name} must be set to run the integration suite.`);
  }

  return value;
}
