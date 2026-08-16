import { MAX_CUSTOM_DOMAINS_PER_TENANT, type TenantDomain } from '@whatsappcrm/contracts';
import type { BadgeTone } from '@/components/ui/Badge';

/**
 * What the console may offer for a given domain row, derived from the row rather
 * than re-decided in the markup.
 *
 * Every rule here mirrors one the API enforces, and each is a refusal a
 * supervisor would otherwise meet as a failed request:
 *
 *   - the **platform subdomain can never be removed** — it is the tenant's floor,
 *     and a tenant that deleted its last domain would be unreachable and
 *     unrecoverable without an operator;
 *   - **primary may only be moved to a hostname that is both proved and
 *     serving**, because invite and password-reset links are mailed to it:
 *     pointing those at an unverified host is the attack the link service exists
 *     to prevent, and pointing them at a verified one that the edge has not
 *     attached yet sends every member to a hostname with no certificate while
 *     the mail itself reports success;
 *   - **verification is only offered while there is something to verify**.
 *
 * Kept out of the components so the rules are testable and stated once. The API
 * is the enforcement; this is what stops the UI offering a button it knows will
 * be refused.
 */

export interface DomainCapabilities {
  readonly canVerify: boolean;
  readonly canMakePrimary: boolean;
  readonly canRemove: boolean;
}

export function domainCapabilities(domain: TenantDomain): DomainCapabilities {
  const isPlatform = domain.kind === 'platform';

  return {
    // Nothing to prove for a subdomain we issued ourselves.
    canVerify: !isPlatform && domain.verifiedAt === null,
    // A platform subdomain is served by the same edge as every other tenant's,
    // so it is deliverable as soon as it exists and is never activated. A custom
    // domain waits for an operator to attach it — `activatedAt`, `status: 'live'`
    // — and the API refuses the promotion until then, so the button is not
    // offered until then either.
    canMakePrimary:
      !domain.isPrimary && (isPlatform ? domain.verifiedAt !== null : domain.activatedAt !== null),
    canRemove: !isPlatform,
  };
}

/**
 * The badge tone for a status.
 *
 * `verified` is deliberately `info` rather than `success`: ownership is proved
 * but the domain is not serving traffic yet, and a green badge beside a hostname
 * that still answers nothing is the kind of half-truth somebody files a bug
 * against. `live` is the only success here.
 */
export function domainStatusTone(status: TenantDomain['status']): BadgeTone {
  switch (status) {
    case 'live':
      return 'success';
    case 'verified':
      return 'info';
    case 'pending_verification':
      return 'warning';
    case 'expired':
      return 'danger';
  }
}

/**
 * The platform subdomain first, then custom domains oldest first.
 *
 * A stable order that does not move under a re-render: the row a supervisor is
 * reading DNS records from must not jump because another one was verified.
 */
export function orderDomains(domains: readonly TenantDomain[]): readonly TenantDomain[] {
  return [...domains].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'platform' ? -1 : 1;
    }

    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
}

/** True once the tenant holds as many custom domains as the plan allows. */
export function hasReachedDomainLimit(domains: readonly TenantDomain[]): boolean {
  return countCustomDomains(domains) >= MAX_CUSTOM_DOMAINS_PER_TENANT;
}

export function countCustomDomains(domains: readonly TenantDomain[]): number {
  return domains.filter((domain) => domain.kind === 'custom').length;
}
