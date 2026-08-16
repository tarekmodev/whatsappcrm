import { toTenantDomain, type TenantDomainRow } from './tenant-domain.mapper';

const TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const NOW = new Date('2026-08-16T12:00:00.000Z');
const CONTEXT = { edgeHostname: 'whatsappcrm-web-prod.onrender.com', verificationTtlMs: TTL_MS };

function row(overrides: Partial<TenantDomainRow> = {}): TenantDomainRow {
  return {
    id: '0192f00e-0000-7000-8000-000000000e01',
    hostname: 'support.acme.example',
    kind: 'custom',
    isPrimary: false,
    verifiedAt: null,
    activatedAt: null,
    verificationToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    verificationRequestedAt: NOW,
    verificationLastCheckedAt: null,
    verificationFailureReason: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('toTenantDomain', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * The status is derived rather than stored, because a stored one is a second
   * source of truth that disagrees with its own columns after one failed write.
   */
  describe('the derived status', () => {
    it('is pending while the challenge is unanswered', () => {
      expect(toTenantDomain(row(), CONTEXT).status).toBe('pending_verification');
    });

    it('is verified once ownership is proved, even before the edge routes it', () => {
      // A verified-but-unattached domain receives no traffic; nothing is broken,
      // and the tenant needs to see that their half is done.
      expect(toTenantDomain(row({ verifiedAt: NOW }), CONTEXT).status).toBe('verified');
    });

    it('is live once the operator has attached it', () => {
      expect(toTenantDomain(row({ verifiedAt: NOW, activatedAt: NOW }), CONTEXT).status).toBe(
        'live',
      );
    });

    it('is expired once an unproved claim has outlived its window', () => {
      // Computed from the clock rather than from the row's continued existence:
      // reclaim latency is one sweep interval, so an expired row is visible
      // before the sweeper removes it.
      const lapsed = new Date(NOW.getTime() - TTL_MS - 1_000);

      expect(toTenantDomain(row({ verificationRequestedAt: lapsed }), CONTEXT).status).toBe(
        'expired',
      );
    });

    it('never reads a verified domain as expired, however old the claim', () => {
      const lapsed = new Date(NOW.getTime() - TTL_MS - 1_000);

      expect(
        toTenantDomain(row({ verificationRequestedAt: lapsed, verifiedAt: NOW }), CONTEXT).status,
      ).toBe('verified');
    });
  });

  describe('the records a tenant is given', () => {
    it('names the challenge label and the prefixed token', () => {
      const domain = toTenantDomain(row(), CONTEXT);

      expect(domain.verification).toMatchObject({
        recordType: 'TXT',
        recordName: '_whatsappcrm-challenge.support.acme.example',
        recordValue: 'whatsappcrm-domain-verification=a1b2c3d4e5f60718293a4b5c6d7e8f90',
      });
    });

    it('says when the claim lapses, so the tenant knows they are on a clock', () => {
      expect(toTenantDomain(row(), CONTEXT).verification?.expiresAt).toBe(
        new Date(NOW.getTime() + TTL_MS).toISOString(),
      );
    });

    it('points the CNAME at this environment’s edge host', () => {
      expect(toTenantDomain(row(), CONTEXT).routing).toEqual({
        recordType: 'CNAME',
        recordName: 'support.acme.example',
        recordValue: CONTEXT.edgeHostname,
      });
    });

    it('withdraws the routing record once the domain is live', () => {
      // By then the record is published and correct, and continuing to show it
      // invites somebody to "fix" a working zone.
      expect(
        toTenantDomain(row({ verifiedAt: NOW, activatedAt: NOW }), CONTEXT).routing,
      ).toBeNull();
    });

    it('gives a platform subdomain neither, because there is nothing to prove or point', () => {
      const platform = toTenantDomain(
        row({ kind: 'platform', verificationToken: null, verifiedAt: NOW, activatedAt: NOW }),
        CONTEXT,
      );

      expect(platform.verification).toBeNull();
      expect(platform.routing).toBeNull();
    });

    it('omits the routing record where the environment has no edge host', () => {
      // The claim is refused before a row exists in that state; this is the
      // backstop for rows written before the variable was set.
      expect(toTenantDomain(row(), { ...CONTEXT, edgeHostname: null }).routing).toBeNull();
    });
  });

  it('carries the last failure so a settings screen can say why', () => {
    const domain = toTenantDomain(
      row({ verificationLastCheckedAt: NOW, verificationFailureReason: 'record_not_found' }),
      CONTEXT,
    );

    expect(domain.verification?.lastFailureReason).toBe('record_not_found');
    expect(domain.verification?.lastCheckedAt).toBe(NOW.toISOString());
  });
});
