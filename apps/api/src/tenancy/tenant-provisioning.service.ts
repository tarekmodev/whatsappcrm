import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type $Enums, type Prisma } from '../generated/prisma/client';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import { isUniqueViolationOn } from '../prisma/unique-violation';
import { PlatformHostnameTakenError, TenantSlugTakenError } from './tenant-provisioning.errors';

/**
 * Defaults for a freshly provisioned tenant. They mirror the column defaults in
 * `schema.prisma` rather than replacing them: the database still has the last
 * word for a row written by anything other than this service, and stating them
 * here keeps the seeded values visible at the place an operator reads.
 */
const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_LOCALE = 'en';

/**
 * Namespace for the advisory lock, so the hash cannot collide with a lock some
 * other feature takes on the same slug.
 */
const PROVISIONING_LOCK_PREFIX = 'tenant-provisioning:';

/**
 * Long enough for the seed to finish on a slow database, short enough that a
 * stuck provisioning releases its advisory lock rather than blocking every
 * other request for the same slug behind it.
 */
const TRANSACTION_TIMEOUT_MS = 15_000;

/** What provisioning writes, and the only columns it reads back. */
export interface ProvisionedTenant {
  id: string;
  slug: string;
  name: string;
  status: $Enums.TenantStatus;
  /** The platform subdomain the tenant is reachable on. */
  primaryHostname: string;
  timezone: string;
  locale: string;
  createdAt: Date;
}

export interface ProvisionTenantCommand {
  slug: string;
  name: string;
  timezone?: string;
  locale?: string;
}

export interface ProvisionTenantResult {
  tenant: ProvisionedTenant;
  /** False when the slug was already provisioned and this call changed nothing. */
  created: boolean;
}

/**
 * Admin-triggered tenant provisioning (TAR-19, first acceptance criterion).
 *
 * Creates the three rows that make a tenant exist and be reachable:
 *
 *   `tenants`         the tenant itself
 *   `tenant_settings` its operational defaults — timezone, locale
 *   `tenant_domains`  its platform subdomain, so host → tenant resolution can
 *                     find it. A tenant with no domain is unreachable by every
 *                     entry point in TAR-39's request pipeline.
 *
 * and nothing else. In particular it creates no users (TAR-35 invites the first
 * one), no branding row (TAR-29 owns branding, including whether that row is
 * written eagerly) and no subscription (TAR-37). Seeding a table another story
 * owns would fix its defaults here, in the wrong place.
 *
 * ## Why `SystemPrisma`
 *
 * `tenants` carries no RLS policy and `TenantPrisma` refuses to write it — by
 * construction, since there is no tenant in scope before the tenant exists.
 * Provisioning is the first of the five call sites TAR-39 permits for the
 * unscoped client. Nothing here reads or writes another tenant's rows: every
 * statement names the tenant it just created.
 *
 * ## Idempotency and atomicity
 *
 * `slug` is the identity of a provisioning request. Everything happens inside
 * one interactive transaction that first takes a transaction-scoped advisory
 * lock on that slug, which gives three properties the acceptance criteria ask
 * for:
 *
 *   * **Idempotent.** A repeat call finds the tenant and returns it unchanged.
 *     It never overwrites `name` or reactivates a suspended tenant — a rename is
 *     `PATCH /tenant` and a reactivation is TAR-36's, and silently doing either
 *     from a provisioning endpoint is how a live tenant gets clobbered by a
 *     replayed script.
 *   * **Convergent.** A tenant missing its settings or its platform domain — a
 *     tenant created by an older version, or by a fixture — has them added. Only
 *     what is missing is written.
 *   * **All or nothing.** A failure anywhere rolls the whole transaction back,
 *     so there is no tenant row without the rows that make it usable. The
 *     advisory lock is released by the same rollback.
 */
@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly config: ConfigService,
  ) {}

  async provision(command: ProvisionTenantCommand): Promise<ProvisionTenantResult> {
    const hostname = this.platformHostnameFor(command.slug);

    const result = await this.systemPrisma
      .$transaction(
        async (tx) => {
          // Serialises concurrent provisioning of the same slug. Held to the end
          // of the transaction and released by commit or rollback, so a crashed
          // provisioner cannot leave it held. The unique index on `tenants.slug`
          // remains the actual guarantee; this turns a lost race into a wait
          // rather than into an error the operator has to interpret.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PROVISIONING_LOCK_PREFIX + command.slug}))`;

          const existing = await findProvisionedTenant(tx, command.slug);

          return existing === null
            ? { tenant: await createTenant(tx, command, hostname), created: true }
            : { tenant: await completeTenant(tx, existing, command, hostname), created: false };
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      )
      .catch((error: unknown) => {
        // The two collisions an operator can act on. Anything else is a fault and
        // stays untranslated, so it is logged as one rather than reported to the
        // operator as their mistake.
        if (isUniqueViolationOn(error, 'hostname')) {
          throw new PlatformHostnameTakenError(hostname);
        }

        if (isUniqueViolationOn(error, 'slug')) {
          throw new TenantSlugTakenError(command.slug);
        }

        throw error;
      });

    this.logger.log(
      result.created
        ? `Provisioned tenant ${result.tenant.slug} (${result.tenant.id}) at ${hostname}`
        : `Tenant ${result.tenant.slug} (${result.tenant.id}) was already provisioned; no changes made`,
    );

    return result;
  }

  /**
   * `acme` → `acme.app.example.com`. Derived, never accepted from the caller:
   * a client-supplied hostname is how one tenant claims another's subdomain.
   */
  private platformHostnameFor(slug: string): string {
    const domain = this.config.getOrThrow<string>('PLATFORM_DOMAIN');

    return `${slug}.${domain}`.toLowerCase();
  }
}

/**
 * The shape read back from an existing tenant: its own columns, plus just
 * enough of the two child rows to tell whether they are there. `settings` and
 * `domains` are projections, not whole rows — nothing needs the rest.
 */
type ExistingTenant = NonNullable<Awaited<ReturnType<typeof findProvisionedTenant>>>;

function findProvisionedTenant(tx: Prisma.TransactionClient, slug: string) {
  return tx.tenant.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      createdAt: true,
      settings: { select: { timezone: true, locale: true } },
      // Any platform domain, not specifically the one this slug maps to: a
      // tenant that already has one keeps it even if `PLATFORM_DOMAIN` has
      // changed since, rather than silently collecting a second subdomain.
      domains: {
        where: { kind: 'platform' },
        select: { hostname: true },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        take: 1,
      },
    },
  });
}

/**
 * The whole tenant in one statement group. Nested writes keep it that way: the
 * settings row and the domain row are inserted with the tenant, inside the
 * caller's transaction, so a constraint failure on either leaves no tenant.
 */
async function createTenant(
  tx: Prisma.TransactionClient,
  command: ProvisionTenantCommand,
  hostname: string,
): Promise<ProvisionedTenant> {
  const timezone = command.timezone ?? DEFAULT_TIMEZONE;
  const locale = command.locale ?? DEFAULT_LOCALE;

  const tenant = await tx.tenant.create({
    data: {
      slug: command.slug,
      name: command.name,
      // Provisioning completes inside this transaction, so the tenant is never
      // observable in the `pending` state the column defaults to — a tenant row
      // exists only once everything it needs exists with it.
      status: 'active',
      settings: { create: { timezone, locale } },
      domains: {
        create: {
          hostname,
          kind: 'platform',
          isPrimary: true,
          // Ours to issue, under our own DNS zone: there is nothing for the
          // customer to prove, unlike a custom domain (TAR-29).
          verifiedAt: new Date(),
        },
      },
    },
    select: { id: true, slug: true, name: true, status: true, createdAt: true },
  });

  return { ...tenant, primaryHostname: hostname, timezone, locale };
}

/**
 * Fills in whatever an already-provisioned tenant is missing, and touches
 * nothing that is present. This is the repair half of idempotency: a tenant
 * whose settings row was never written gets one, without its name, status or
 * existing settings being reset to the values in this request.
 */
async function completeTenant(
  tx: Prisma.TransactionClient,
  existing: ExistingTenant,
  command: ProvisionTenantCommand,
  hostname: string,
): Promise<ProvisionedTenant> {
  const settings =
    existing.settings ??
    (await tx.tenantSettings.create({
      data: {
        tenantId: existing.id,
        timezone: command.timezone ?? DEFAULT_TIMEZONE,
        locale: command.locale ?? DEFAULT_LOCALE,
      },
      select: { timezone: true, locale: true },
    }));

  const platformDomain =
    existing.domains[0] ??
    (await tx.tenantDomain.create({
      data: {
        tenantId: existing.id,
        hostname,
        kind: 'platform',
        isPrimary: true,
        verifiedAt: new Date(),
      },
      select: { hostname: true },
    }));

  return {
    id: existing.id,
    slug: existing.slug,
    name: existing.name,
    status: existing.status,
    createdAt: existing.createdAt,
    primaryHostname: platformDomain.hostname,
    timezone: settings.timezone,
    locale: settings.locale,
  };
}
