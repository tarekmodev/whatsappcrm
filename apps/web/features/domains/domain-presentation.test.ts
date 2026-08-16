import { describe, expect, it } from 'vitest';
import { MAX_CUSTOM_DOMAINS_PER_TENANT, type TenantDomain } from '@whatsappcrm/contracts';
import {
  domainCapabilities,
  domainStatusTone,
  hasReachedDomainLimit,
  orderDomains,
} from './domain-presentation';

function domain(overrides: Partial<TenantDomain> = {}): TenantDomain {
  return {
    id: '0192f000-0000-7000-8000-00000000d001',
    hostname: 'support.acme.com',
    kind: 'custom',
    status: 'pending_verification',
    isPrimary: false,
    verifiedAt: null,
    activatedAt: null,
    verification: null,
    routing: null,
    createdAt: '2026-08-10T09:00:00.000Z',
    ...overrides,
  };
}

describe('domainCapabilities', () => {
  it('never offers to remove the platform subdomain', () => {
    // A tenant that deleted its last domain would be unreachable, and no button
    // in this console may make that reachable by accident.
    const platform = domain({ kind: 'platform', status: 'live', verifiedAt: NOW, isPrimary: true });

    expect(domainCapabilities(platform).canRemove).toBe(false);
  });

  it('never offers to verify the platform subdomain', () => {
    const platform = domain({ kind: 'platform', status: 'live', verifiedAt: NOW });

    expect(domainCapabilities(platform).canVerify).toBe(false);
  });

  it('offers verification only while the claim is unproved', () => {
    expect(domainCapabilities(domain()).canVerify).toBe(true);
    expect(domainCapabilities(domain({ status: 'verified', verifiedAt: NOW })).canVerify).toBe(
      false,
    );
  });

  it('refuses to make an unverified hostname primary', () => {
    // Invite and password-reset links are mailed to the primary domain.
    expect(domainCapabilities(domain()).canMakePrimary).toBe(false);
    expect(domainCapabilities(domain({ verifiedAt: NOW })).canMakePrimary).toBe(true);
  });

  it('does not offer to re-make the current primary primary', () => {
    expect(domainCapabilities(domain({ verifiedAt: NOW, isPrimary: true })).canMakePrimary).toBe(
      false,
    );
  });
});

describe('domainStatusTone', () => {
  it('keeps success for live only, because verified is not yet serving traffic', () => {
    expect(domainStatusTone('live')).toBe('success');
    expect(domainStatusTone('verified')).not.toBe('success');
  });
});

describe('orderDomains', () => {
  it('puts the platform subdomain first, then custom domains oldest first', () => {
    const platform = domain({ id: 'p', kind: 'platform', createdAt: '2026-08-12T00:00:00.000Z' });
    const older = domain({ id: 'a', createdAt: '2026-08-01T00:00:00.000Z' });
    const newer = domain({ id: 'b', createdAt: '2026-08-05T00:00:00.000Z' });

    expect(orderDomains([newer, platform, older]).map((item) => item.id)).toEqual(['p', 'a', 'b']);
  });

  it('does not mutate the list it was given', () => {
    const items = [domain({ id: 'b', createdAt: '2026-08-05T00:00:00.000Z' }), domain({ id: 'a' })];

    orderDomains(items);

    expect(items.map((item) => item.id)).toEqual(['b', 'a']);
  });
});

describe('hasReachedDomainLimit', () => {
  it('counts custom domains only — the platform subdomain is not one of the five', () => {
    const custom = Array.from({ length: MAX_CUSTOM_DOMAINS_PER_TENANT - 1 }, (_unused, index) =>
      domain({ id: `c${index}` }),
    );

    expect(hasReachedDomainLimit([domain({ kind: 'platform' }), ...custom])).toBe(false);
    expect(hasReachedDomainLimit([...custom, domain({ id: 'last' })])).toBe(true);
  });
});

const NOW = '2026-08-14T10:00:00.000Z';
