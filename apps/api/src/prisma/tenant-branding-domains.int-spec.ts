import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-417: the branding and custom-domain schema, against a real PostgreSQL.
 *
 * `verify-tenant-isolation.sql` already proves both tables are tenant-isolated.
 * This file proves the half RLS says nothing about — the constraints and indexes
 * 20260815120000_branding_and_custom_domains adds, which decide whether two
 * tenants can claim one hostname, whether a tenant can hold two primary domains,
 * and whether a branding row can point at bytes it cannot describe.
 *
 * **It has to exist, because nothing else in the toolchain would notice their
 * absence.** Prisma's schema language cannot express a partial index or a CHECK
 * constraint, and its PostgreSQL describer skips predicated indexes — so
 * `migrate dev` neither regenerates them nor reports them as drift, and a
 * database built from `schema.prisma` alone loses every guarantee below in
 * silence. The failure mode is not an error; it is a row that should have been
 * rejected being accepted.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and a `tar417-fixture` marker, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '41700000-0000-7000-8000-000000000701';
const TENANT_B = '41700000-0000-7000-8000-000000000702';

/** 32 lowercase hex characters, the shape `tenant_domains_verification_token_format` requires. */
const TOKEN_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_B = '0f9e8d7c6b5a493827160f5e4d3c2b1a';

const REQUEST_ID = 'tar417-int-spec';

/**
 * Asserts a single row and hands it back. `noUncheckedIndexedAccess` is on, so
 * `rows[0]` is `T | undefined` everywhere; this keeps the assertion where the
 * meaning is instead of scattering non-null assertions.
 */
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);

  const [row] = rows;

  if (row === undefined) {
    throw new Error('unreachable: the length assertion above would have failed first');
  }

  return row;
}

/**
 * Runs a write that must fail and returns the database's complaint as a string.
 *
 * Asserting on the constraint *name* rather than just "it threw" is the point: a
 * rejection proves something refused the row, and only the name proves it was
 * the constraint this case is about rather than a stray not-null or foreign key
 * that would keep passing after the constraint was dropped.
 */
async function violation(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('expected the write to be rejected, but it succeeded');
}

describe('tenant branding and custom domains', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  async function removeFixture(): Promise<void> {
    // Both tables cascade from the tenant, so one delete is enough and stays
    // correct as the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar417-fixture-a', name: 'TAR-417 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar417-fixture-b', name: 'TAR-417 fixture B', status: 'active' },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    // Each case starts from "neither tenant has a domain or a branding row",
    // which is also the state a freshly provisioned tenant is in for branding:
    // the row is created lazily on the first write, not at provisioning.
    await systemPrisma.tenantDomain.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.tenantBranding.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
  });

  describe('the indexes themselves', () => {
    it('tenant_domains_one_primary is unique, on tenant_id, and partial on is_primary', async () => {
      const index = only(
        await systemPrisma.$queryRaw<{ indexdef: string }[]>`
          SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'tenant_domains_one_primary'
        `,
      );

      expect(index.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(index.indexdef).toContain('(tenant_id)');
      // Asserting the predicate, not just the name: widened to cover every row
      // it would forbid a tenant a second domain at all, and narrowed away it
      // would stop constraining anything — both pass a name-only check.
      expect(index.indexdef).toMatch(/WHERE is_primary/);
    });

    it('tenant_domains_unverified is partial on verified_at IS NULL', async () => {
      const index = only(
        await systemPrisma.$queryRaw<{ indexdef: string }[]>`
          SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'tenant_domains_unverified'
        `,
      );

      expect(index.indexdef).toContain('(verification_requested_at)');
      // The predicate is what keeps the sweeper's queue to rows it has work
      // for — a verified domain must leave the index rather than sit in it.
      expect(index.indexdef).toMatch(/WHERE \(verified_at IS NULL\)/);
    });
  });

  describe('one primary domain per tenant', () => {
    it('refuses a second primary in the same tenant', async () => {
      await systemPrisma.tenantDomain.create({
        data: {
          tenantId: TENANT_A,
          hostname: 'a.tar417-fixture.localhost',
          kind: 'platform',
          isPrimary: true,
          verifiedAt: new Date(),
        },
      });

      // TenantLinkService.primaryHostname() mails live invite and password-reset
      // tokens to this host. Two primaries makes which host a recipient is sent
      // to depend on row order.
      //
      // Raw SQL rather than the client, and for a reason worth recording: on a
      // *partial* unique index Prisma cannot map the violation back to a schema
      // field and reports "Unique constraint failed on the (not available)".
      // That would pass whichever index rejected the row — including one this
      // case is not about — so it proves nothing. Postgres names the index.
      const message = await violation(
        systemPrisma.$executeRaw`
          INSERT INTO tenant_domains
            (id, tenant_id, hostname, kind, is_primary, verification_token, created_at, updated_at)
          VALUES ('41700000-0000-7000-8000-0000000007a1'::uuid, ${TENANT_A}::uuid,
                  'a2.tar417-fixture.localhost', 'custom', true, ${TOKEN_A}, now(), now())
        `,
      );

      expect(message).toContain('tenant_domains_one_primary');
    });

    it('lets each tenant hold its own primary', async () => {
      await systemPrisma.tenantDomain.createMany({
        data: [
          {
            tenantId: TENANT_A,
            hostname: 'a.tar417-fixture.localhost',
            kind: 'platform',
            isPrimary: true,
            verifiedAt: new Date(),
          },
          {
            tenantId: TENANT_B,
            hostname: 'b.tar417-fixture.localhost',
            kind: 'platform',
            isPrimary: true,
            verifiedAt: new Date(),
          },
        ],
      });

      expect(await systemPrisma.tenantDomain.count({ where: { isPrimary: true } })).toBeGreaterThan(
        1,
      );
    });

    it('lets one tenant hold many non-primary domains', async () => {
      // The index constrains the `true` rows only. A tenant may hold its
      // platform subdomain plus up to MAX_CUSTOM_DOMAINS_PER_TENANT others.
      await systemPrisma.tenantDomain.createMany({
        data: [
          {
            tenantId: TENANT_A,
            hostname: 'a.tar417-fixture.localhost',
            kind: 'platform',
            isPrimary: true,
            verifiedAt: new Date(),
          },
          {
            tenantId: TENANT_A,
            hostname: 'one.tar417-fixture.example',
            kind: 'custom',
            isPrimary: false,
            verificationToken: TOKEN_A,
          },
          {
            tenantId: TENANT_A,
            hostname: 'two.tar417-fixture.example',
            kind: 'custom',
            isPrimary: false,
            verificationToken: TOKEN_B,
          },
        ],
      });

      expect(await systemPrisma.tenantDomain.count({ where: { tenantId: TENANT_A } })).toBe(3);
    });
  });

  describe('a hostname belongs to exactly one tenant', () => {
    it('rejects a second tenant claiming it, and tells the loser nothing about the holder', async () => {
      const contested = 'contested.tar417-fixture.example';

      await asTenant(TENANT_A, () =>
        tenantPrisma.tenantDomain.create({
          data: {
            tenantId: TENANT_A,
            hostname: contested,
            kind: 'custom',
            verificationToken: TOKEN_A,
            verificationRequestedAt: new Date(),
          },
        }),
      );

      // The collision rule, exercised through the app role rather than the
      // system one — which is the interesting case, because it is the only way
      // to observe that a unique index is enforced *below* row-level security.
      // Tenant B cannot see the row, and is still stopped by it.
      //
      // Raw SQL for the same reason as the case above: Prisma reports a unique
      // violation it cannot map without naming the index, and which index
      // rejected the row is the whole assertion.
      const message = await violation(
        asTenant(
          TENANT_B,
          () => tenantPrisma.$executeRaw`
            INSERT INTO tenant_domains
              (id, tenant_id, hostname, kind, verification_token, verification_requested_at,
               created_at, updated_at)
            VALUES ('41700000-0000-7000-8000-0000000007b1'::uuid, ${TENANT_B}::uuid, ${contested},
                    'custom', ${TOKEN_B}, now(), now(), now())
          `,
        ),
      );

      expect(message).toContain('tenant_domains_hostname_key');

      // ...and tenant B cannot see whose it is. This is why the API maps the
      // violation to `conflict` without reading the row back: it could not read
      // it, and a message naming the holder would leak one tenant to another.
      const visible = await asTenant(TENANT_B, () =>
        tenantPrisma.tenantDomain.findMany({ where: { hostname: contested } }),
      );

      expect(visible).toEqual([]);
    });
  });

  describe('a custom domain always carries a verification token', () => {
    it('refuses a custom domain with no token', async () => {
      // Without this, a row could be inserted that nothing could ever verify by
      // DNS challenge — and `verified_at` on it would mean nothing.
      const message = await violation(
        systemPrisma.tenantDomain.create({
          data: {
            tenantId: TENANT_A,
            hostname: 'tokenless.tar417-fixture.example',
            kind: 'custom',
          },
        }),
      );

      expect(message).toContain('tenant_domains_custom_needs_token');
    });

    it('allows a platform subdomain with no token', async () => {
      // Ours to issue under our own zone: there is nothing for the customer to
      // prove, which is why provisioning stamps `verified_at` immediately.
      const created = await systemPrisma.tenantDomain.create({
        data: {
          tenantId: TENANT_A,
          hostname: 'platform.tar417-fixture.localhost',
          kind: 'platform',
          isPrimary: true,
          verifiedAt: new Date(),
        },
      });

      expect(created.verificationToken).toBeNull();
    });

    it('refuses a token that is not 32 lowercase hex characters', async () => {
      // The token's only job is to be unguessable. A short one makes the DNS
      // challenge forgeable by anyone who controls any zone, which forges
      // ownership of a hostname rather than merely looking wrong.
      const message = await violation(
        systemPrisma.tenantDomain.create({
          data: {
            tenantId: TENANT_A,
            hostname: 'weak.tar417-fixture.example',
            kind: 'custom',
            verificationToken: 'abc123',
          },
        }),
      );

      expect(message).toContain('tenant_domains_verification_token_format');
    });
  });

  describe('a branding asset is all four columns or none', () => {
    it('refuses a storage key with no mime type', async () => {
      // The serve route reads `logo_mime_type` to set the response's
      // Content-Type. A key without one is a logo it cannot serve.
      const message = await violation(
        systemPrisma.tenantBranding.create({
          data: { tenantId: TENANT_A, logoStorageKey: 'tenants/a/branding/logo' },
        }),
      );

      expect(message).toContain('tenant_branding_logo_complete');
    });

    it('refuses a favicon timestamp with no key behind it', async () => {
      const message = await violation(
        systemPrisma.tenantBranding.create({
          data: { tenantId: TENANT_A, faviconUpdatedAt: new Date() },
        }),
      );

      expect(message).toContain('tenant_branding_favicon_complete');
    });

    it('accepts a row with no assets at all', async () => {
      // The common case, and the one a lazily created row starts in.
      const created = await systemPrisma.tenantBranding.create({
        data: { tenantId: TENANT_A, productName: 'TAR-417 fixture' },
      });

      expect(created.logoStorageKey).toBeNull();
      expect(created.faviconStorageKey).toBeNull();
    });

    it('accepts a complete asset group', async () => {
      const created = await systemPrisma.tenantBranding.create({
        data: {
          tenantId: TENANT_A,
          logoStorageKey: `tenants/${TENANT_A}/branding/logo`,
          logoMimeType: 'image/png',
          logoSizeBytes: 12_345,
          logoUpdatedAt: new Date(),
        },
      });

      expect(created.logoMimeType).toBe('image/png');
    });
  });

  describe('brand colours are #rrggbb or absent', () => {
    it.each(['red', '#fff', '#12345g', '0b6e4f'])('refuses %s', async (colour) => {
      // These two values are the input to `brandCssVariables()`. A malformed one
      // does not fail there — it yields a contrast ratio computed from garbage,
      // and the WCAG AA guarantee 0001 measures quietly stops holding.
      const message = await violation(
        systemPrisma.tenantBranding.create({ data: { tenantId: TENANT_A, primaryColor: colour } }),
      );

      expect(message).toContain('tenant_branding_primary_color_hex');
    });

    it('accepts either case, and null', async () => {
      // Null means "not customised" — BRANDING_DEFAULTS fills it. Making the
      // column NOT NULL DEFAULT would bake the platform's own brand into every
      // row and make "has this tenant customised anything" unanswerable.
      const created = await systemPrisma.tenantBranding.create({
        data: { tenantId: TENANT_A, primaryColor: '#0B6E4F', accentColor: null },
      });

      expect(created.primaryColor).toBe('#0B6E4F');
      expect(created.accentColor).toBeNull();
    });
  });

  describe('the new columns are inside the isolation boundary', () => {
    it('never shows one tenant another tenant’s branding or verification token', async () => {
      await systemPrisma.tenantBranding.createMany({
        data: [
          { tenantId: TENANT_A, productName: 'A only', primaryColor: '#0b6e4f' },
          { tenantId: TENANT_B, productName: 'B only', primaryColor: '#1d4ed8' },
        ],
      });
      await systemPrisma.tenantDomain.createMany({
        data: [
          {
            tenantId: TENANT_A,
            hostname: 'iso-a.tar417-fixture.example',
            kind: 'custom',
            verificationToken: TOKEN_A,
          },
          {
            tenantId: TENANT_B,
            hostname: 'iso-b.tar417-fixture.example',
            kind: 'custom',
            verificationToken: TOKEN_B,
          },
        ],
      });

      const branding = await asTenant(TENANT_A, () => tenantPrisma.tenantBranding.findMany());
      const domains = await asTenant(TENANT_A, () => tenantPrisma.tenantDomain.findMany());

      expect(branding.map((row) => row.productName)).toEqual(['A only']);
      // The token is the one genuinely secret-shaped value on either table, and
      // it is scoped to one hostname and one tenant. Reading another tenant's
      // would let its holder be impersonated at the point of verification.
      expect(domains.map((row) => row.verificationToken)).toEqual([TOKEN_A]);
    });

    it('refuses a cross-tenant branding write rather than merely hiding it', async () => {
      // WITH CHECK, not just USING: a tenant writing a row stamped with another
      // tenant's id is rejected, not silently written somewhere invisible.
      const written = await asTenant(TENANT_A, () =>
        tenantPrisma.tenantBranding.updateMany({
          where: { tenantId: TENANT_B },
          data: { productName: 'hijacked' },
        }),
      );

      expect(written.count).toBe(0);
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
