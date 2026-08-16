import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAX_CUSTOM_DOMAINS_PER_TENANT, type TenantDomain } from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS, type AuditAction } from '../../audit/audit.actions';
import { AuditService } from '../../audit/audit.service';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import type { Prisma } from '../../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../../prisma/prisma.tokens';
import { isUniqueViolationOn } from '../../prisma/unique-violation';
import {
  DomainNotVerifiedError,
  DomainRoutingUnconfiguredError,
  DomainVerificationThrottledError,
  PlatformDomainNotRemovableError,
  ApexHostnameNotClaimableError,
  PlatformHostnameNotClaimableError,
  TenantDomainNotFoundError,
  TenantDomainTakenError,
  TooManyCustomDomainsError,
} from '../tenancy.errors';
import { DomainOwnershipChecker } from './domain-ownership.checker';
import { isApexHostname, isPlatformHostname } from './hostname-policy';
import {
  TENANT_DOMAIN_PROJECTION,
  toTenantDomain,
  type DomainRoutingContext,
  type TenantDomainRow,
} from './tenant-domain.mapper';

/** 16 bytes of CSPRNG as 32 lowercase hex, the shape the CHECK constraint requires. */
const VERIFICATION_TOKEN_BYTES = 16;

/**
 * The floor between two ownership checks on one domain.
 *
 * Durable — it is `verification_last_checked_at` on the row, not a counter in a
 * cache — so it holds across replicas and across a restart, which a per-process
 * window would not. Combined with `MAX_CUSTOM_DOMAINS_PER_TENANT` it caps a
 * tenant at 30 lookups a minute, which is what actually matters: a verify is one
 * outbound DNS query to a nameserver the *tenant* nominated, so an unbounded one
 * is a small amplification vector pointed wherever they like.
 *
 * TAR-416 also specifies 20 checks per hour per tenant. That one is not built:
 * it needs a shared counter with a sliding window, which means Redis, and
 * failing open on an unreachable Redis (the trade `LoginThrottleService` makes
 * and documents) would leave this floor as the only real control anyway. Stated
 * here rather than quietly dropped.
 */
const VERIFY_FLOOR_MS = 10_000;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface ClaimedDomain {
  readonly domain: TenantDomain;
  /** False when this call found an existing claim by the same tenant. */
  readonly created: boolean;
}

/**
 * A tenant's own hostnames: claiming one, proving it, promoting it, removing it
 * (TAR-29, the tenant-facing half of TAR-416's endpoint surface).
 *
 * ## Three responsibilities, and only one of them is here
 *
 * *Delivery* — a TLS connection for `support.acme.com` reaching our web service
 * — is the edge's, and an operator's (TAR-419). *Resolution* — a request
 * becoming a tenant id — is `HostTenantGuard`'s, and this story does not touch
 * it. What this service owns is *authorisation to be resolved*: the row, and
 * whether `verified_at` is set on it.
 *
 * The isolation argument for custom domains falls out of that split. A verified
 * domain that is not attached receives no traffic; an attached domain that is
 * not verified answers `tenant_not_found`. Both halves must hold, and neither
 * party controls both.
 *
 * ## Everything is scoped by RLS, and the collision is settled by the database
 *
 * Every statement goes through `TenantPrisma`. `hostname citext UNIQUE` is
 * global and — the property that makes this work — is enforced **below**
 * row-level security, so a tenant claiming a hostname another tenant holds gets
 * a unique violation without being able to read, or learn anything about, the
 * conflicting row. This service maps that violation to `conflict` and never
 * reads the row back: it could not, and a message naming the holder would leak
 * one tenant to another.
 */
@Injectable()
export class TenantDomainsService {
  private readonly logger = new Logger(TenantDomainsService.name);

  private readonly platformDomain: string;
  private readonly edgeHostname: string | null;
  private readonly verificationTtlMs: number;

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly ownership: DomainOwnershipChecker,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
    config: ConfigService,
  ) {
    this.platformDomain = config.getOrThrow<string>('PLATFORM_DOMAIN');
    this.edgeHostname = config.get<string>('PLATFORM_EDGE_HOSTNAME') ?? null;
    this.verificationTtlMs =
      config.getOrThrow<number>('DOMAIN_VERIFICATION_TTL_DAYS') * MILLISECONDS_PER_DAY;
  }

  /**
   * Every hostname this tenant holds, platform subdomain included.
   *
   * The platform subdomain is in the list rather than filtered out because it is
   * the address that keeps working while a custom domain is being set up, and a
   * settings screen that does not show it cannot explain why the tenant is still
   * reachable after removing everything else.
   */
  async list(): Promise<TenantDomain[]> {
    const rows = await this.prisma.tenantDomain.findMany({
      select: TENANT_DOMAIN_PROJECTION,
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });

    return rows.map((row) => this.present(row));
  }

  /**
   * Claims `hostname` for this tenant and issues the DNS challenge.
   *
   * Idempotent for the claimant: re-adding a hostname this tenant already holds
   * returns the existing row rather than erroring, because a double-submitted
   * form is not a conflict. A claim of this tenant's own that has **lapsed** is
   * re-issued with a fresh token and a fresh clock — a repair that touches
   * nobody else's row, and the alternative would be a tenant locked out of its
   * own hostname until the sweeper got to it.
   */
  async claim(hostname: string): Promise<ClaimedDomain> {
    const tenantId = this.tenantContext.requireTenantId();

    if (isPlatformHostname(hostname, this.platformDomain)) {
      throw new PlatformHostnameNotClaimableError(hostname);
    }

    if (isApexHostname(hostname)) {
      // Verifies happily and can never be routed: a root domain cannot take the
      // CNAME the routing record hands back. Refused here rather than in the
      // published schema — see `hostname-policy.ts`.
      throw new ApexHostnameNotClaimableError(hostname);
    }

    if (this.edgeHostname === null) {
      // Refused rather than answered with a blank routing target: a tenant that
      // publishes a CNAME to nothing waits for a verification that cannot
      // arrive, and the misconfiguration surfaces days later as a support
      // ticket instead of immediately.
      throw new DomainRoutingUnconfiguredError();
    }

    const existing = await this.prisma.tenantDomain.findFirst({
      where: { hostname },
      select: TENANT_DOMAIN_PROJECTION,
    });

    if (existing !== null) {
      return { domain: await this.refreshLapsedClaim(existing), created: false };
    }

    const held = await this.prisma.tenantDomain.count({ where: { kind: 'custom' } });

    if (held >= MAX_CUSTOM_DOMAINS_PER_TENANT) {
      throw new TooManyCustomDomainsError(MAX_CUSTOM_DOMAINS_PER_TENANT);
    }

    const row = await this.prisma
      .$tenantTransaction(async (tx) => {
        const created = await tx.tenantDomain.create({
          data: {
            tenantId,
            hostname,
            kind: 'custom',
            verificationToken: newVerificationToken(),
            verificationRequestedAt: new Date(),
          },
          select: TENANT_DOMAIN_PROJECTION,
        });

        await this.recordDomainAudit(tx, AUDIT_ACTIONS.tenantDomainClaimed, created);

        return created;
      })
      .catch((error: unknown) => {
        if (isUniqueViolationOn(error, 'hostname')) {
          // Another tenant holds it. The row is unreadable from here and is not
          // read: the response says only that the hostname is taken.
          throw new TenantDomainTakenError(hostname);
        }

        throw error;
      });

    this.logger.log(`Tenant ${tenantId} claimed ${hostname}; awaiting DNS verification`);

    return { domain: this.present(row), created: true };
  }

  /**
   * Checks the DNS challenge now, on the tenant's request.
   *
   * A failure is **200 with the domain**, carrying `status:
   * 'pending_verification'` and a `lastFailureReason` — not an error envelope.
   * Nothing went wrong with the request; the record is not there yet, which is a
   * state on the resource and by far the most common answer.
   */
  async verify(id: string): Promise<TenantDomain> {
    const row = await this.require(id);

    if (row.kind === 'platform' || row.verificationToken === null) {
      // Ours to issue, verified at provisioning, and nothing to re-check. Not an
      // error: a settings screen that lists every domain may reasonably offer
      // the same button on all of them.
      return this.present(row);
    }

    if (row.verifiedAt !== null) {
      // Already proved. Re-checking would only create a path for a DNS blip to
      // un-verify a live domain, which TAR-416 rules out explicitly.
      return this.present(row);
    }

    this.assertCheckAllowed(row);

    const outcome = await this.ownership.check(row.hostname, row.verificationToken);
    const now = new Date();

    const updated = await this.prisma.$tenantTransaction(async (tx) => {
      const next = await tx.tenantDomain.update({
        where: { id: row.id },
        data: {
          verificationLastCheckedAt: now,
          verificationAttempts: { increment: 1 },
          verifiedAt: outcome.proved ? now : null,
          verificationFailureReason: outcome.proved ? null : outcome.reason,
        },
        select: TENANT_DOMAIN_PROJECTION,
      });

      if (outcome.proved) {
        await this.recordDomainAudit(tx, AUDIT_ACTIONS.tenantDomainVerified, next);
      }

      return next;
    });

    if (outcome.proved) {
      this.logger.log(`${row.hostname} proved ownership and now resolves to its tenant`);
    }

    return this.present(updated);
  }

  /**
   * Makes one domain the tenant's primary address.
   *
   * Refuses a domain that is not verified, and that refusal is security-relevant
   * rather than tidiness: `TenantLinkService.primaryHostname()` builds invite and
   * password-reset links from this row, so pointing it at a hostname nobody has
   * proved control of mails a live token to a host the tenant does not own.
   *
   * One transaction, because `tenant_domains_one_primary` is a unique index: the
   * old primary has to be cleared before the new one is set or the second
   * statement collides with the first.
   */
  async setPrimary(id: string): Promise<TenantDomain> {
    const row = await this.require(id);

    if (row.verifiedAt === null) {
      throw new DomainNotVerifiedError(row.hostname);
    }

    if (row.isPrimary) {
      return this.present(row);
    }

    const updated = await this.prisma.$tenantTransaction(async (tx) => {
      await tx.tenantDomain.updateMany({ where: { isPrimary: true }, data: { isPrimary: false } });

      return await tx.tenantDomain.update({
        where: { id: row.id },
        data: { isPrimary: true },
        select: TENANT_DOMAIN_PROJECTION,
      });
    });

    return this.present(updated);
  }

  /**
   * Releases a custom domain. It stops resolving immediately — the row is what
   * `HostTenantGuard` reads, so removing it is the whole revocation.
   *
   * A platform subdomain is refused outright: it is the tenant's floor, and a
   * tenant that deletes its last hostname is unreachable and unrecoverable
   * without operator help. Removing the current primary moves primary back to
   * the platform subdomain in the same transaction, for the same reason the
   * promotion above is transactional.
   *
   * Detaching the hostname at the edge and cleaning up DNS are the operator's
   * and the tenant's respectively; neither is on this path, and neither is
   * needed for the domain to stop serving.
   */
  async remove(id: string): Promise<void> {
    const row = await this.require(id);

    if (row.kind === 'platform') {
      throw new PlatformDomainNotRemovableError();
    }

    await this.prisma.$tenantTransaction(async (tx) => {
      await this.recordDomainAudit(tx, AUDIT_ACTIONS.tenantDomainRemoved, row);
      await tx.tenantDomain.delete({ where: { id: row.id } });

      if (!row.isPrimary) {
        return;
      }

      const fallback = await tx.tenantDomain.findFirst({
        where: { kind: 'platform' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });

      if (fallback === null) {
        // Nothing to fall back to. Left without a primary rather than refused:
        // the tenant asked to remove a domain it owns, and `primaryHostname()`
        // already tolerates the absence. Worth a line, because a tenant with no
        // platform subdomain is a provisioning fault this did not cause.
        this.logger.warn(
          `Tenant ${this.tenantContext.requireTenantId()} removed its primary domain and has no ` +
            'platform subdomain to fall back to',
        );

        return;
      }

      await tx.tenantDomain.update({ where: { id: fallback.id }, data: { isPrimary: true } });
    });
  }

  /** The row, or `not_found` — never `forbidden`, which would confirm it exists elsewhere. */
  private async require(id: string): Promise<TenantDomainRow> {
    const row = await this.prisma.tenantDomain.findFirst({
      where: { id },
      select: TENANT_DOMAIN_PROJECTION,
    });

    if (row === null) {
      throw new TenantDomainNotFoundError();
    }

    return row;
  }

  /**
   * Re-issues the challenge on this tenant's own lapsed claim, or hands the
   * existing row back unchanged.
   */
  private async refreshLapsedClaim(row: TenantDomainRow): Promise<TenantDomain> {
    const lapsed =
      row.verifiedAt === null &&
      row.verificationRequestedAt !== null &&
      Date.now() - row.verificationRequestedAt.getTime() > this.verificationTtlMs;

    if (!lapsed) {
      return this.present(row);
    }

    const refreshed = await this.prisma.tenantDomain.update({
      where: { id: row.id },
      data: {
        verificationToken: newVerificationToken(),
        verificationRequestedAt: new Date(),
        verificationAttempts: 0,
        verificationFailureReason: null,
        verificationLastCheckedAt: null,
      },
      select: TENANT_DOMAIN_PROJECTION,
    });

    return this.present(refreshed);
  }

  /** The per-domain floor. See `VERIFY_FLOOR_MS`. */
  private assertCheckAllowed(row: TenantDomainRow): void {
    const lastCheckedAt = row.verificationLastCheckedAt;

    if (lastCheckedAt === null) {
      return;
    }

    const elapsed = Date.now() - lastCheckedAt.getTime();

    if (elapsed < VERIFY_FLOOR_MS) {
      throw new DomainVerificationThrottledError(
        // Never zero: a `Retry-After: 0` invites an immediate retry.
        Math.max(1, Math.ceil((VERIFY_FLOOR_MS - elapsed) / 1_000)),
      );
    }
  }

  private present(row: TenantDomainRow): TenantDomain {
    return toTenantDomain(row, this.routingContext());
  }

  private routingContext(): DomainRoutingContext {
    return { edgeHostname: this.edgeHostname, verificationTtlMs: this.verificationTtlMs };
  }

  /**
   * One audit row per domain lifecycle event, inside the caller's transaction.
   *
   * The hostname is metadata rather than a second target column, and the
   * **token is never written**: this table is exported for compliance review,
   * and while the token is not a credential it is still a value that only ever
   * needs to exist in one place.
   */
  private async recordDomainAudit(
    tx: Prisma.TransactionClient,
    action: AuditAction,
    row: Pick<TenantDomainRow, 'id' | 'hostname' | 'kind'>,
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      targetType: 'tenant_domain',
      targetId: row.id,
      metadata: { hostname: row.hostname, kind: row.kind },
    });
  }
}

/**
 * A fresh challenge token.
 *
 * `randomBytes`, never `Math.random`: the token's only job is to be unguessable,
 * because a short or predictable one makes the DNS challenge forgeable by
 * whoever controls *any* zone — and that forges ownership of a hostname rather
 * than merely looking wrong.
 */
function newVerificationToken(): string {
  return randomBytes(VERIFICATION_TOKEN_BYTES).toString('hex');
}
