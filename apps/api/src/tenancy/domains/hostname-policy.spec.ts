import { isApexHostname, isPlatformHostname } from './hostname-policy';

/**
 * The rule that stops a tenant claiming `rival.app.example.com` — a host under
 * the zone we issue platform subdomains from, which we would then attach a
 * certificate to and route to whoever asked for it.
 */
describe('isPlatformHostname', () => {
  const PLATFORM = 'app.example.com';

  it.each([
    'app.example.com',
    'acme.app.example.com',
    'rival.app.example.com',
    'deep.nested.app.example.com',
  ])('claims %s for the platform', (hostname) => {
    expect(isPlatformHostname(hostname, PLATFORM)).toBe(true);
  });

  it('does not swallow a hostname that merely ends with the same letters', () => {
    // `endsWith(platformDomain)` without the leading dot would refuse this, and
    // it is a hostname a tenant can legitimately own.
    expect(isPlatformHostname('notapp.example.com', PLATFORM)).toBe(false);
  });

  it.each(['support.acme.com', 'example.com', 'app.example.com.evil.test'])(
    'leaves %s claimable',
    (hostname) => {
      expect(isPlatformHostname(hostname, PLATFORM)).toBe(false);
    },
  );

  it('compares case-insensitively, since DNS does', () => {
    expect(isPlatformHostname('ACME.App.Example.COM', PLATFORM)).toBe(true);
  });
});

/**
 * A root domain cannot take a `CNAME`, so a claim on one verifies and then can
 * never be routed. The published schema requires only two labels — the console
 * ships against it — so this rule lives server-side rather than tightening a
 * contract another tier already validates with.
 */
describe('isApexHostname', () => {
  it.each(['acme.com', 'example.org', 'acme'])('refuses %s', (hostname) => {
    expect(isApexHostname(hostname)).toBe(true);
  });

  it.each(['support.acme.com', 'help.acme.co.uk', 'a.b.c.example.com'])(
    'accepts %s',
    (hostname) => {
      expect(isApexHostname(hostname)).toBe(false);
    },
  );

  it('lets an apex under a multi-label public suffix through, which is the known gap', () => {
    // `acme.co.uk` is an apex with three labels. Telling it apart exactly needs a
    // Public Suffix List; the claim is accepted here and simply never routes,
    // which is the same inert end state as a claim whose DNS was never published.
    expect(isApexHostname('acme.co.uk')).toBe(false);
  });
});
