import {
  domainChallengeRecordName,
  domainChallengeRecordValue,
  type TenantDomain,
  type TenantDomainStatus,
} from '@whatsappcrm/contracts';
import type { $Enums } from '../../generated/prisma/client';

/**
 * The columns a domain response is built from. Named as a type so the queries
 * that feed this mapper and the mapper itself cannot drift — widening the
 * projection has to happen here first.
 */
export interface TenantDomainRow {
  readonly id: string;
  readonly hostname: string;
  readonly kind: $Enums.TenantDomainKind;
  readonly isPrimary: boolean;
  readonly verifiedAt: Date | null;
  readonly activatedAt: Date | null;
  readonly verificationToken: string | null;
  readonly verificationRequestedAt: Date | null;
  readonly verificationLastCheckedAt: Date | null;
  readonly verificationFailureReason: $Enums.TenantDomainVerificationFailureReason | null;
  readonly createdAt: Date;
}

/** Exactly `TenantDomainRow`, as a Prisma `select`. */
export const TENANT_DOMAIN_PROJECTION = {
  id: true,
  hostname: true,
  kind: true,
  isPrimary: true,
  verifiedAt: true,
  activatedAt: true,
  verificationToken: true,
  verificationRequestedAt: true,
  verificationLastCheckedAt: true,
  verificationFailureReason: true,
  createdAt: true,
} as const;

/** What the mapper needs from configuration to describe the DNS records. */
export interface DomainRoutingContext {
  /** `PLATFORM_EDGE_HOSTNAME`, or null where this environment has none. */
  readonly edgeHostname: string | null;
  /** How long an unverified claim survives. */
  readonly verificationTtlMs: number;
}

/**
 * A `tenant_domains` row as the published `TenantDomain`.
 *
 * ## The status is derived, never stored
 *
 * A stored status is a second source of truth that disagrees with its own
 * columns after one failed write — the row says `verified` and `verified_at` is
 * null, and now two pieces of code answer the same question differently. So the
 * four states are computed here, in one place, from the three timestamps that
 * actually decide them.
 *
 * ## What is deliberately *not* hidden
 *
 * The verification token is returned to the tenant that owns the row, because it
 * has to be: the tenant pastes it into their own DNS, and they will ask for it
 * again. It is published in public DNS by design, so it is not a credential —
 * proving it means controlling that hostname, and it is scoped to one hostname
 * and one tenant. RLS is what keeps it out of everybody else's response.
 */
export function toTenantDomain(row: TenantDomainRow, context: DomainRoutingContext): TenantDomain {
  const status = statusOf(row, context.verificationTtlMs);

  return {
    id: row.id,
    hostname: row.hostname,
    kind: row.kind,
    status,
    isPrimary: row.isPrimary,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    verification: verificationOf(row, context.verificationTtlMs),
    routing: routingOf(row, status, context.edgeHostname),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `live` once the edge is serving it, `verified` once ownership is proved,
 * `expired` once an unproved claim has outlived its window, `pending` otherwise.
 *
 * Order matters: activation implies verification, and the expiry check must come
 * after both so a verified domain never reads as expired.
 */
function statusOf(row: TenantDomainRow, verificationTtlMs: number): TenantDomainStatus {
  if (row.activatedAt !== null) {
    return 'live';
  }

  if (row.verifiedAt !== null) {
    return 'verified';
  }

  return isExpired(row, verificationTtlMs) ? 'expired' : 'pending_verification';
}

/**
 * An unverified claim past its window. The sweeper has not necessarily removed
 * it yet — reclaim latency is one sweep interval, which is documented behaviour
 * rather than a bug — so the status is computed from the clock rather than from
 * the row's continued existence.
 */
function isExpired(row: TenantDomainRow, verificationTtlMs: number): boolean {
  const requestedAt = row.verificationRequestedAt;

  return requestedAt !== null && Date.now() - requestedAt.getTime() > verificationTtlMs;
}

/**
 * Null for a platform subdomain: it is ours to issue under our own zone, so
 * there is nothing for the customer to prove and no record for them to publish.
 * `tenant_domains_custom_needs_token` is the database half of the same rule.
 */
function verificationOf(row: TenantDomainRow, verificationTtlMs: number) {
  if (row.kind === 'platform' || row.verificationToken === null) {
    return null;
  }

  const requestedAt = row.verificationRequestedAt ?? row.createdAt;

  return {
    recordType: 'TXT' as const,
    recordName: domainChallengeRecordName(row.hostname),
    recordValue: domainChallengeRecordValue(row.verificationToken),
    lastCheckedAt: row.verificationLastCheckedAt?.toISOString() ?? null,
    lastFailureReason: row.verificationFailureReason,
    expiresAt: new Date(requestedAt.getTime() + verificationTtlMs).toISOString(),
  };
}

/**
 * Where the tenant points its DNS, until it has.
 *
 * Withdrawn once the domain is `live`, because by then the record is published
 * and correct, and continuing to show it invites somebody to "fix" a working
 * zone. Null for a platform subdomain, which we point ourselves; null too where
 * the environment has no `PLATFORM_EDGE_HOSTNAME` — though in that case the
 * claim was refused before a row existed, so this branch is a backstop for rows
 * written before the variable was set.
 */
function routingOf(row: TenantDomainRow, status: TenantDomainStatus, edgeHostname: string | null) {
  if (row.kind === 'platform' || status === 'live' || edgeHostname === null) {
    return null;
  }

  return {
    // A subdomain is all this platform accepts (`CustomHostnameInputSchema`),
    // and a subdomain always takes a CNAME. The other two the schema allows are
    // for an apex, which is refused — see docs/runbooks/custom-domains.md.
    recordType: 'CNAME' as const,
    recordName: row.hostname,
    recordValue: edgeHostname,
  };
}
