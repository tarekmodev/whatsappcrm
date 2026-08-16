import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from './rbac';
import {
  BRANDING_ASSET_LIMITS,
  BRANDING_DEFAULTS,
  brandingAssetPath,
  CustomHostnameInputSchema,
  domainChallengeRecordName,
  domainChallengeRecordValue,
  TENANT_DOMAIN_KINDS,
  TenantDomainSchema,
  TenantUpdateInputSchema,
} from './tenant';

/**
 * The branding and custom-domain half of the tenant contract (TAR-29, against
 * TAR-416).
 *
 * What is worth pinning here is the part a reader cannot see from the shapes:
 * which hostnames a tenant may claim, that an asset never crosses the wire as an
 * absolute URL, and that the domain vocabulary matches the database enum it is
 * read straight out of.
 */

describe('the branding asset path', () => {
  it('is relative, so the same row serves under both of a tenant’s hosts', () => {
    // An absolute URL would name whichever host existed at write time and make
    // the browser fetch cross-origin under the other — which drops the session
    // cookie (0002, decision 3).
    const path = brandingAssetPath('logo', new Date('2026-08-16T10:00:00.000Z'));

    expect(path.startsWith('/api/v1/')).toBe(true);
    expect(path).not.toMatch(/^https?:/);
  });

  it('carries the asset’s own timestamp, so a new upload is a new URL', () => {
    const first = brandingAssetPath('logo', new Date('2026-08-16T10:00:00.000Z'));
    const second = brandingAssetPath('logo', new Date('2026-08-16T10:00:01.000Z'));

    expect(first).not.toBe(second);
  });
});

describe('branding asset limits', () => {
  it('never accepts SVG, on either asset', () => {
    // An SVG served same-origin executes script, and a sanitiser is a security
    // dependency to own forever.
    for (const limit of Object.values(BRANDING_ASSET_LIMITS)) {
      expect(limit.mimeTypes).not.toContain('image/svg+xml');
      expect(limit.maxBytes).toBeGreaterThan(0);
    }
  });
});

describe('branding defaults', () => {
  it('fills every column a tenant may leave unset', () => {
    // The columns stay nullable in the database; these are what the API
    // substitutes so the frontend renders unconditionally.
    expect(BRANDING_DEFAULTS.productName.length).toBeGreaterThan(0);
    expect(BRANDING_DEFAULTS.primaryColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(BRANDING_DEFAULTS.accentColor).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('the tenant update input', () => {
  it('does not let a JSON patch write an asset', () => {
    // The bytes are set by their own multipart routes. A partial of the
    // response shape would publish a path this endpoint refuses to honour.
    const parsed = TenantUpdateInputSchema.parse({
      branding: { primaryColor: '#0b6e4f', logo: { path: '/nope' } },
    });

    expect(parsed.branding).toEqual({ primaryColor: '#0b6e4f' });
  });
});

describe('the domain vocabulary', () => {
  it('spells the kind exactly as the database enum does', () => {
    // The wire value *is* the column value, so there is no mapping layer for
    // the two to drift through. `platform_subdomain` was a value the column
    // could never hold.
    expect(TENANT_DOMAIN_KINDS).toEqual(['platform', 'custom']);
  });

  it('leaves a platform subdomain with nothing to prove and nothing to point', () => {
    const parsed = TenantDomainSchema.parse({
      id: '01234567-89ab-7cde-8f01-23456789abcd',
      hostname: 'acme.app.example.com',
      kind: 'platform',
      status: 'live',
      isPrimary: true,
      verifiedAt: '2026-08-16T10:00:00.000Z',
      activatedAt: '2026-08-16T10:00:00.000Z',
      verification: null,
      routing: null,
      createdAt: '2026-08-16T10:00:00.000Z',
    });

    expect(parsed.verification).toBeNull();
  });
});

describe('the DNS challenge', () => {
  it('is published under a label a zone cannot already be using for something else', () => {
    expect(domainChallengeRecordName('support.acme.com')).toBe(
      '_whatsappcrm-challenge.support.acme.com',
    );
    expect(domainChallengeRecordValue('a'.repeat(32))).toBe(
      `whatsappcrm-domain-verification=${'a'.repeat(32)}`,
    );
  });
});

describe('a claimable hostname', () => {
  const claim = (hostname: string) => CustomHostnameInputSchema.safeParse(hostname);

  it.each([
    'support.acme.com',
    'help.acme.co.uk',
    'a.b.c.d.example.com',
    'xn--80ak6aa92e.example.com',
  ])('accepts %s', (hostname) => {
    expect(claim(hostname).success).toBe(true);
  });

  it('normalises case and stray whitespace rather than refusing them', () => {
    // `hostname` is `citext` and the guard lowercases what it resolves, so a
    // pasted `Support.Acme.com ` is the same claim rather than a second one.
    expect(claim('  Support.Acme.COM ').data).toBe('support.acme.com');
  });

  it('accepts a root domain, which the API then refuses for a reason of its own', () => {
    // Two labels is what this schema requires, and the console validates against
    // it. Whether a *root* domain is claimable is a routing question — a root
    // domain cannot take a CNAME — so `hostname-policy.ts` in the API refuses it
    // rather than this schema tightening under a tier already shipped against it.
    expect(claim('acme.com').success).toBe(true);
  });

  it.each([
    ['a bare label', 'acme'],
    ['a trailing dot', 'support.acme.com.'],
    ['a port', 'support.acme.com:443'],
    ['a scheme', 'https://support.acme.com'],
    ['an IPv4 literal', '203.0.113.7'],
    ['a bracketed IPv6 literal', '[2001:db8::1]'],
    ['localhost', 'localhost'],
    ['a machine-local name', 'box.local'],
    ['an internal name', 'api.internal'],
    ['a label starting with a hyphen', '-bad.acme.com'],
    ['a label ending with a hyphen', 'bad-.acme.com'],
    ['an empty label', 'support..acme.com'],
    ['an underscore', 'sup_port.acme.com'],
    ['a non-ASCII name', 'пример.acme.com'],
  ])('refuses %s', (_label, hostname) => {
    expect(claim(hostname).success).toBe(false);
  });

  it('refuses a hostname long enough to break a DNS message', () => {
    expect(claim(`${'a'.repeat(64)}.acme.com`).success).toBe(false);
    expect(claim(`${'a.'.repeat(130)}acme.com`).success).toBe(false);
  });
});

describe('the domain permission', () => {
  it('is separate from branding, because they are different authorities', () => {
    // Control of a hostname decides where a live password-reset token is
    // mailed; choosing a logo colour does not.
    expect(PERMISSIONS).toContain('domain:write');
    expect(PERMISSIONS).toContain('branding:write');
  });
});
