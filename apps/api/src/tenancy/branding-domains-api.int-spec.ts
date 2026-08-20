import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { TenantLinkService } from '../identity/mailer/tenant-link.service';
import { FilesystemMediaStorage } from '../media/storage/filesystem-media.storage';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { AdminDomainsService } from './admin/admin-domains.service';
import { TenantBrandingService } from './branding/tenant-branding.service';
import { DomainOwnershipChecker } from './domains/domain-ownership.checker';
import { TenantDomainsService } from './domains/tenant-domains.service';
import { HostTenantGuard } from './host-tenant.guard';
import { TenantProfileService } from './tenant-profile.service';
import {
  DomainNotActivatedError,
  DomainNotVerifiedError,
  PlatformDomainNotRemovableError,
  PlatformHostnameNotClaimableError,
  TenantDomainNotFoundError,
  TenantDomainTakenError,
} from './tenancy.errors';

/**
 * TAR-420's acceptance criteria against a real PostgreSQL with TAR-48's policies
 * applied and a real object store on disk.
 *
 * A unit test can show that a service passes a hostname to `findFirst`. Only this
 * can show that `tenant_domains` and `tenant_branding` actually carry the
 * `tenant_isolation` policy, that the global unique index on `hostname` is
 * enforced **below** RLS — so a losing claimant is stopped by a row it cannot
 * read — and that an unverified custom domain resolves to nothing. Everything
 * below runs as `whatsappcrm_app`, the role holding no `BYPASSRLS`.
 *
 * The four things it proves, which are the story's acceptance criteria:
 *
 *   1. branding written by tenant A is what A's host serves, and B's host never
 *      serves it;
 *   2. a **verified** custom domain resolves to its tenant, and an unverified one
 *      answers `tenant_not_found` — the same answer an unknown host gets;
 *   3. two tenants racing for one hostname: the loser gets `conflict` and learns
 *      nothing about the holder;
 *   4. no tenant identity is ever taken from the caller — every read below is
 *      scoped by the host the guard resolved and by RLS, never by an id in a
 *      request.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Two fixture tenants
 * with fixed ids and a `tar420-fixture` marker, deleted before the run as well as
 * after it, so an interrupted run cleans up on the next one. Point `pnpm test:db`
 * at a local or disposable database.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '42000000-0000-7000-8000-000000000401';
const TENANT_B = '42000000-0000-7000-8000-000000000402';

const FIXTURE_PREFIX = 'tar420-fixture';
const HOST_A = `${FIXTURE_PREFIX}-a.app.localhost`;
const HOST_B = `${FIXTURE_PREFIX}-b.app.localhost`;
const CUSTOM_A = 'support.tar420-a.example';
const CONTESTED = 'contested.tar420.example';

const REQUEST_ID = 'tar420-int-spec';
const PLATFORM_DOMAIN = 'app.localhost';
const EDGE_HOSTNAME = 'whatsappcrm-web-test.onrender.invalid';
const TTL_DAYS = 7;

/** A minimal PNG: the signature plus a marker, so the bytes are identifiable. */
const LOGO_A = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('tenant A only'),
]);
const LOGO_B = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('tenant B only'),
]);

/** The `ConfigService` surface these services actually read. */
function configWith(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];

      if (value === undefined) {
        throw new Error(`${key} is not configured in this fixture`);
      }

      return value;
    },
  } as unknown as ConfigService;
}

/** A request as `HostTenantGuard` reads one: a host, and no trusted-edge headers. */
function requestAt(hostname: string): ExecutionContext {
  const handler = (): void => undefined;

  return {
    switchToHttp: () => ({ getRequest: () => ({ hostname, header: () => undefined }) }),
    getHandler: () => handler,
    getClass: () => class Probe {},
  } as unknown as ExecutionContext;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

describe('branding and custom domains, end to end', () => {
  const tenantContext = new TenantContextService();

  let root: string;
  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let branding: TenantBrandingService;
  let profile: TenantProfileService;
  let domains: TenantDomainsService;
  let adminDomains: AdminDomainsService;
  let links: TenantLinkService;
  let guard: HostTenantGuard;

  /** What the stubbed DNS resolver will answer next. */
  let publishedTxt: Record<string, string[][]> = {};

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  /** Runs the guard for `hostname` and returns the tenant it put in scope. */
  async function resolve(hostname: string): Promise<string | null> {
    return await tenantContext.run(
      { requestId: REQUEST_ID, tenantId: null, userId: null },
      async () => {
        await guard.canActivate(requestAt(hostname));

        return tenantContext.tenantId;
      },
    );
  }

  /**
   * TAR-419's operator step, which has no tenant-facing route: the hostname is
   * attached at the edge and its certificate issued. Written through
   * `systemPrisma` because that is the plane an operator acts on, and because
   * most cases here are about `TenantDomainsService` rather than the operator
   * surface. The block that *is* about the operator surface drives
   * `adminDomains` directly.
   */
  async function activateAtEdge(hostname: string): Promise<void> {
    await systemPrisma.tenantDomain.updateMany({
      where: { hostname },
      data: { activatedAt: new Date() },
    });
  }

  /** Verifies `hostname` for `tenantId` the way a tenant does, and answers its id. */
  async function claimAndVerify(tenantId: string, hostname: string): Promise<string> {
    const claimed = await asTenant(tenantId, () => domains.claim(hostname));

    publishedTxt[`_whatsappcrm-challenge.${hostname}`] = [
      [claimed.domain.verification?.recordValue ?? ''],
    ];

    await asTenant(tenantId, () => domains.verify(claimed.domain.id));

    return claimed.domain.id;
  }

  async function removeFixture(): Promise<void> {
    // Both tables cascade from the tenant, so one delete is enough and stays
    // correct as the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    // Belt and braces for the contested hostname, which a failed run may have
    // left under a tenant this fixture does not own.
    await systemPrisma.tenantDomain.deleteMany({ where: { hostname: CONTESTED } });
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'tar420-int-'));
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    const storage = new FilesystemMediaStorage(configWith({ MEDIA_STORAGE_ROOT: root }));
    const audit = new AuditService(tenantContext);
    const ownership = new DomainOwnershipChecker({
      resolveTxt: (name: string) =>
        publishedTxt[name] === undefined
          ? Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }))
          : Promise.resolve(publishedTxt[name]),
    });

    branding = new TenantBrandingService(
      tenantPrisma,
      storage,
      tenantContext,
      configWith({ PLATFORM_PRODUCT_NAME: 'Fixture CRM' }),
    );
    profile = new TenantProfileService(tenantPrisma, branding);
    domains = new TenantDomainsService(
      tenantPrisma,
      ownership,
      audit,
      tenantContext,
      configWith({
        PLATFORM_DOMAIN,
        PLATFORM_EDGE_HOSTNAME: EDGE_HOSTNAME,
        DOMAIN_VERIFICATION_TTL_DAYS: TTL_DAYS,
      }),
    );
    adminDomains = new AdminDomainsService(systemPrisma, tenantPrisma, audit);
    links = new TenantLinkService(
      tenantPrisma,
      configWith({ APP_LINK_SCHEME: 'https', PLATFORM_DOMAIN }),
    );
    guard = new HostTenantGuard(
      new Reflector(),
      systemPrisma,
      tenantContext,
      configWith({}) as never,
    );
  });

  afterAll(async () => {
    await removeFixture();
    await rm(root, { recursive: true, force: true });
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    publishedTxt = {};

    await removeFixture();
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: `${FIXTURE_PREFIX}-a`, name: 'TAR-420 tenant A', status: 'active' },
        { id: TENANT_B, slug: `${FIXTURE_PREFIX}-b`, name: 'TAR-420 tenant B', status: 'active' },
      ],
    });
    // The platform subdomain each tenant is issued at provisioning: ours to
    // issue, so verified on creation and carrying no token.
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
  });

  describe('host resolution', () => {
    it('maps each platform subdomain to its own tenant', async () => {
      await expect(resolve(HOST_A)).resolves.toBe(TENANT_A);
      await expect(resolve(HOST_B)).resolves.toBe(TENANT_B);
    });

    it('refuses a host no tenant holds', async () => {
      await expect(resolve('nobody.app.localhost')).rejects.toBeInstanceOf(ApiException);
    });

    it('does not resolve an unverified custom domain', async () => {
      // The row exists while DNS is still being proved. Honouring it early would
      // let a customer claim a hostname they have not demonstrated control of —
      // and the answer is the same `tenant_not_found` an unknown host gets, so it
      // cannot be used to discover which hostnames are claimed.
      await asTenant(TENANT_A, () => domains.claim(CUSTOM_A));

      await expect(resolve(CUSTOM_A)).rejects.toBeInstanceOf(ApiException);
    });

    it('resolves it the moment ownership is proved, and stops the moment it is removed', async () => {
      const claimed = await asTenant(TENANT_A, () => domains.claim(CUSTOM_A));

      publishedTxt[`_whatsappcrm-challenge.${CUSTOM_A}`] = [
        [claimed.domain.verification?.recordValue ?? ''],
      ];

      const verified = await asTenant(TENANT_A, () => domains.verify(claimed.domain.id));

      expect(verified.status).toBe('verified');
      await expect(resolve(CUSTOM_A)).resolves.toBe(TENANT_A);

      await asTenant(TENANT_A, () => domains.remove(claimed.domain.id));

      // Removal is the whole revocation: the row is what the guard reads, so the
      // hostname stops serving immediately rather than when an operator gets to
      // it at the edge.
      await expect(resolve(CUSTOM_A)).rejects.toBeInstanceOf(ApiException);
    });

    it('leaves the tenant unresolved for a domain verified against the wrong token', async () => {
      const claimed = await asTenant(TENANT_A, () => domains.claim(CUSTOM_A));

      publishedTxt[`_whatsappcrm-challenge.${CUSTOM_A}`] = [
        [`whatsappcrm-domain-verification=${'f'.repeat(32)}`],
      ];

      const checked = await asTenant(TENANT_A, () => domains.verify(claimed.domain.id));

      expect(checked.status).toBe('pending_verification');
      expect(checked.verification?.lastFailureReason).toBe('record_mismatch');
      await expect(resolve(CUSTOM_A)).rejects.toBeInstanceOf(ApiException);
    });
  });

  describe('branding is served under the tenant’s own host and nowhere else', () => {
    it('reflects a colour and a product name a tenant wrote', async () => {
      await asTenant(TENANT_A, () =>
        branding.update({ productName: 'Acme Support', primaryColor: '#0b6e4f' }),
      );

      const forA = await asTenant(TENANT_A, () => profile.readPublic());
      const forB = await asTenant(TENANT_B, () => profile.readPublic());

      expect(forA.branding).toMatchObject({
        productName: 'Acme Support',
        primaryColor: '#0b6e4f',
      });
      // B has written nothing, so it gets the platform defaults — never A's.
      expect(forB.branding.productName).toBe('Fixture CRM');
      expect(forB.branding.primaryColor).not.toBe('#0b6e4f');
    });

    it('serves each tenant its own logo bytes, and never the other’s', async () => {
      await asTenant(TENANT_A, () => branding.replaceAsset('logo', LOGO_A));
      await asTenant(TENANT_B, () => branding.replaceAsset('logo', LOGO_B));

      await expect(
        asTenant(TENANT_A, async () => collect((await branding.readAsset('logo')).body)),
      ).resolves.toEqual(LOGO_A);
      await expect(
        asTenant(TENANT_B, async () => collect((await branding.readAsset('logo')).body)),
      ).resolves.toEqual(LOGO_B);
    });

    it('answers not-found for a tenant that has uploaded nothing, rather than the neighbour’s', async () => {
      await asTenant(TENANT_A, () => branding.replaceAsset('logo', LOGO_A));

      await expect(asTenant(TENANT_B, () => branding.readAsset('logo'))).rejects.toThrow();
    });

    it('namespaces the bytes under the owning tenant’s prefix', async () => {
      await asTenant(TENANT_A, () => branding.replaceAsset('logo', LOGO_A));

      const row = await asTenant(TENANT_A, () =>
        tenantPrisma.tenantBranding.findFirstOrThrow({ select: { logoStorageKey: true } }),
      );

      expect(row.logoStorageKey?.startsWith(`tenants/${TENANT_A}/branding/`)).toBe(true);
    });

    it('sniffs the bytes rather than believing the upload', async () => {
      // An SVG served same-origin executes script. It is not in the allow-list,
      // and no declared content type can put it there — the service is never
      // told what the caller claimed.
      await expect(
        asTenant(TENANT_A, () =>
          branding.replaceAsset('logo', Buffer.from('<svg onload="alert(1)"/>')),
        ),
      ).rejects.toThrow();
    });

    it('replaces rather than accumulating, and leaves the row pointing at the new bytes', async () => {
      await asTenant(TENANT_A, () => branding.replaceAsset('logo', LOGO_A));
      const replaced = await asTenant(TENANT_A, () => branding.replaceAsset('logo', LOGO_B));

      await expect(
        asTenant(TENANT_A, async () => collect((await branding.readAsset('logo')).body)),
      ).resolves.toEqual(LOGO_B);
      // The cache-buster moves with the bytes, so a browser holding the old
      // one-year `immutable` response asks for a different URL.
      expect(replaced.logo?.path).toContain('?v=');
    });

    it('is gone after a delete, and deleting again is not an error', async () => {
      await asTenant(TENANT_A, () => branding.replaceAsset('logo', LOGO_A));
      await asTenant(TENANT_A, () => branding.removeAsset('logo'));
      await asTenant(TENANT_A, () => branding.removeAsset('logo'));

      await expect(asTenant(TENANT_A, () => branding.readAsset('logo'))).rejects.toThrow();
      await expect(asTenant(TENANT_A, () => branding.read())).resolves.toMatchObject({
        logo: null,
      });
    });
  });

  describe('a hostname belongs to exactly one tenant', () => {
    it('refuses the second claimant, and tells them nothing about the holder', async () => {
      await asTenant(TENANT_A, () => domains.claim(CONTESTED));

      const refusal = await asTenant(TENANT_B, () =>
        domains.claim(CONTESTED).catch((error: unknown) => error),
      );

      expect(refusal).toBeInstanceOf(TenantDomainTakenError);
      expect(String(refusal)).not.toContain(TENANT_A);
      expect(String(refusal)).not.toContain(`${FIXTURE_PREFIX}-a`);

      // And B genuinely cannot see it: the unique index is enforced below RLS,
      // which is what lets the collision be settled without a readable row.
      await expect(asTenant(TENANT_B, () => domains.list())).resolves.toEqual([
        expect.objectContaining({ hostname: HOST_B }),
      ]);
    });

    it('hands the same tenant its existing claim back rather than erroring', async () => {
      const first = await asTenant(TENANT_A, () => domains.claim(CONTESTED));
      const second = await asTenant(TENANT_A, () => domains.claim(CONTESTED));

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.domain.id).toBe(first.domain.id);
    });

    it('refuses a hostname under the platform’s own zone', async () => {
      // Ours to issue. Without this a tenant could claim a neighbour's
      // subdomain and have us attach a certificate to it.
      await expect(
        asTenant(TENANT_A, () => domains.claim(`rival.${PLATFORM_DOMAIN}`)),
      ).rejects.toBeInstanceOf(PlatformHostnameNotClaimableError);
    });
  });

  describe('one tenant cannot reach the other’s domains', () => {
    it('lists only its own', async () => {
      await asTenant(TENANT_A, () => domains.claim(CUSTOM_A));

      const forB = await asTenant(TENANT_B, () => domains.list());

      expect(forB.map((domain) => domain.hostname)).toEqual([HOST_B]);
    });

    it('answers not-found for the other tenant’s domain id, never forbidden', async () => {
      // A 403 would confirm the id exists somewhere, which is the enumeration
      // `not_found` avoids.
      const claimed = await asTenant(TENANT_A, () => domains.claim(CUSTOM_A));

      await expect(
        asTenant(TENANT_B, () => domains.verify(claimed.domain.id)),
      ).rejects.toBeInstanceOf(TenantDomainNotFoundError);
      await expect(
        asTenant(TENANT_B, () => domains.remove(claimed.domain.id)),
      ).rejects.toBeInstanceOf(TenantDomainNotFoundError);
    });

    it('never shows one tenant the other’s verification token', async () => {
      // The one genuinely secret-shaped value on the table: reading another
      // tenant's would let its holder be impersonated at the point of proof.
      const claimed = await asTenant(TENANT_A, () => domains.claim(CUSTOM_A));
      const token = claimed.domain.verification?.recordValue ?? '';

      const forB = await asTenant(TENANT_B, () => domains.list());

      expect(JSON.stringify(forB)).not.toContain(token);
    });
  });

  describe('the platform subdomain is the tenant’s floor', () => {
    it('cannot be removed', async () => {
      const [platform] = await asTenant(TENANT_A, () => domains.list());

      await expect(
        asTenant(TENANT_A, () => domains.remove(platform?.id ?? '')),
      ).rejects.toBeInstanceOf(PlatformDomainNotRemovableError);
    });

    it('takes back primary when a promoted custom domain is removed', async () => {
      const claimed = await asTenant(TENANT_A, () => domains.claim(CUSTOM_A));

      publishedTxt[`_whatsappcrm-challenge.${CUSTOM_A}`] = [
        [claimed.domain.verification?.recordValue ?? ''],
      ];

      await asTenant(TENANT_A, () => domains.verify(claimed.domain.id));
      await activateAtEdge(CUSTOM_A);
      await asTenant(TENANT_A, () => domains.setPrimary(claimed.domain.id));
      await asTenant(TENANT_A, () => domains.remove(claimed.domain.id));

      const remaining = await asTenant(TENANT_A, () => domains.list());

      // A tenant whose links point nowhere is a tenant whose password resets are
      // undeliverable, so primary has to land somewhere.
      expect(remaining).toEqual([expect.objectContaining({ hostname: HOST_A, isPrimary: true })]);
    });

    it('refuses to promote a domain nobody has proved', async () => {
      const claimed = await asTenant(TENANT_A, () => domains.claim(CUSTOM_A));

      await expect(
        asTenant(TENANT_A, () => domains.setPrimary(claimed.domain.id)),
      ).rejects.toBeInstanceOf(DomainNotVerifiedError);
    });

    it('refuses to promote a proved domain the edge is not serving yet', async () => {
      // Verification and activation are separate states, and the gap between
      // them is an operator's manual queue. Promoted inside it, every invite and
      // password-reset link is mailed to a hostname with no route and no
      // certificate — and the mail sends without error, so nothing surfaces
      // until a customer cannot get back into their account.
      const claimed = await asTenant(TENANT_A, () => domains.claim(CUSTOM_A));

      publishedTxt[`_whatsappcrm-challenge.${CUSTOM_A}`] = [
        [claimed.domain.verification?.recordValue ?? ''],
      ];

      await asTenant(TENANT_A, () => domains.verify(claimed.domain.id));

      await expect(
        asTenant(TENANT_A, () => domains.setPrimary(claimed.domain.id)),
      ).rejects.toBeInstanceOf(DomainNotActivatedError);

      await activateAtEdge(CUSTOM_A);

      await expect(
        asTenant(TENANT_A, () => domains.setPrimary(claimed.domain.id)),
      ).resolves.toMatchObject({ hostname: CUSTOM_A, isPrimary: true, status: 'live' });
    });

    it('promotes the platform subdomain on verification alone, which never activates', async () => {
      // It is served by the same edge as every other tenant's, so activation is
      // not a state it has — `AdminDomainsService` will not stamp one. Requiring
      // it here would leave the tenant's floor permanently unpromotable, and the
      // floor is where `remove()` puts primary back.
      const claimed = await asTenant(TENANT_A, () => domains.claim(CUSTOM_A));

      publishedTxt[`_whatsappcrm-challenge.${CUSTOM_A}`] = [
        [claimed.domain.verification?.recordValue ?? ''],
      ];

      await asTenant(TENANT_A, () => domains.verify(claimed.domain.id));
      await activateAtEdge(CUSTOM_A);
      await asTenant(TENANT_A, () => domains.setPrimary(claimed.domain.id));

      const platform = (await asTenant(TENANT_A, () => domains.list())).find(
        (domain) => domain.kind === 'platform',
      );

      await expect(
        asTenant(TENANT_A, () => domains.setPrimary(platform?.id ?? '')),
      ).resolves.toMatchObject({ hostname: HOST_A, isPrimary: true, activatedAt: null });
    });
  });

  describe('a detached domain stops being where links are mailed', () => {
    const RESET_PATH = '/reset-password';

    /** Claims, verifies, activates through the operator surface, and promotes. */
    async function goLive(hostname: string): Promise<string> {
      const id = await claimAndVerify(TENANT_A, hostname);

      await asTenant(TENANT_A, () => adminDomains.activate(hostname));
      await asTenant(TENANT_A, () => domains.setPrimary(id));

      return id;
    }

    it('hands primary back to the platform subdomain when an operator detaches it', async () => {
      // The incident this exists for: a certificate fails to renew, an operator
      // detaches the hostname at the edge, and until TAR-534 `is_primary` stayed
      // exactly where `setPrimary` refuses to put it — so every invite and reset
      // link kept naming a host with no route and no certificate.
      await goLive(CUSTOM_A);

      await expect(asTenant(TENANT_A, () => links.absoluteLink(RESET_PATH, 'tok3n'))).resolves.toBe(
        `https://${CUSTOM_A}${RESET_PATH}#token=tok3n`,
      );

      await asTenant(TENANT_A, () => adminDomains.deactivate(CUSTOM_A));

      // Both halves in one assertion set: the flag moved, and the link followed
      // it. The unique index also had to permit the two writes, which it only
      // does because the old primary is cleared before the fallback is set.
      const remaining = await asTenant(TENANT_A, () => domains.list());

      expect(remaining).toEqual([
        expect.objectContaining({ hostname: HOST_A, isPrimary: true }),
        expect.objectContaining({ hostname: CUSTOM_A, isPrimary: false, activatedAt: null }),
      ]);
      await expect(asTenant(TENANT_A, () => links.absoluteLink(RESET_PATH, 'tok3n'))).resolves.toBe(
        `https://${HOST_A}${RESET_PATH}#token=tok3n`,
      );
    });

    it('leaves primary alone when the detached domain was not the primary', async () => {
      const id = await claimAndVerify(TENANT_A, CUSTOM_A);

      await asTenant(TENANT_A, () => adminDomains.activate(CUSTOM_A));
      await asTenant(TENANT_A, () => adminDomains.deactivate(CUSTOM_A));

      const detached = (await asTenant(TENANT_A, () => domains.list())).find(
        (domain) => domain.id === id,
      );

      expect(detached).toMatchObject({ activatedAt: null, isPrimary: false });
      await expect(asTenant(TENANT_A, () => links.absoluteLink(RESET_PATH, 'tok3n'))).resolves.toBe(
        `https://${HOST_A}${RESET_PATH}#token=tok3n`,
      );
    });

    it('skips an unactivated primary even when the flag was left behind', async () => {
      // The state the revert above prevents, forced directly against the table
      // so the net under it is what is being tested rather than the fix that
      // stops it arising. Two statements because `tenant_domains_one_primary`
      // is checked per statement.
      await claimAndVerify(TENANT_A, CUSTOM_A);
      await systemPrisma.tenantDomain.updateMany({
        where: { tenantId: TENANT_A },
        data: { isPrimary: false },
      });
      await systemPrisma.tenantDomain.updateMany({
        where: { hostname: CUSTOM_A },
        data: { isPrimary: true, activatedAt: null },
      });

      await expect(asTenant(TENANT_A, () => links.absoluteLink(RESET_PATH, 'tok3n'))).resolves.toBe(
        `https://${HOST_A}${RESET_PATH}#token=tok3n`,
      );
    });

    it('refuses to detach a domain the named tenant does not hold', async () => {
      await goLive(CUSTOM_A);

      // The operator is authorised for every tenant, but the slug in the path
      // decides whose rows are in scope. RLS is what makes naming the wrong one
      // a not-found rather than a neighbour's primary being reverted.
      await expect(
        asTenant(TENANT_B, () => adminDomains.deactivate(CUSTOM_A)),
      ).rejects.toBeInstanceOf(TenantDomainNotFoundError);

      const stillLive = (await asTenant(TENANT_A, () => domains.list())).find(
        (domain) => domain.hostname === CUSTOM_A,
      );

      expect(stillLive).toMatchObject({ isPrimary: true });
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
