import { describe, expect, it } from 'vitest';
import { DOMAIN_STATUS_DEFAULT, parseDomainStatus, parseRedirectPath, routes } from './routes';
import { isCredentialPath } from './credential-paths';

describe('routes', () => {
  it('encodes the slug an operator typed', () => {
    expect(routes.tenant('north/wind')).toBe('/tenants/north%2Fwind');
  });

  it('carries the trail cursor, and drops it on the newest page', () => {
    expect(routes.tenant('northwind')).toBe('/tenants/northwind');
    expect(routes.tenant('northwind', { cursor: 'abc' })).toBe('/tenants/northwind?cursor=abc');
  });

  /**
   * A parameter that says exactly what the API would have done anyway is one more
   * thing in a shared URL that means nothing to whoever receives it.
   */
  it('spells the queue’s default half as the bare route', () => {
    expect(routes.domains()).toBe('/domains');
    expect(routes.domains({ status: 'live' })).toBe('/domains?status=live');
  });

  it('narrows an untrusted queue filter to a half the API answers', () => {
    expect(parseDomainStatus('live')).toBe('live');
    expect(parseDomainStatus('nonsense')).toBe(DOMAIN_STATUS_DEFAULT);
    expect(parseDomainStatus(undefined)).toBe(DOMAIN_STATUS_DEFAULT);
  });
});

describe('parseRedirectPath', () => {
  const FALLBACK = '/tenants';

  it('keeps an in-app path', () => {
    expect(parseRedirectPath('/domains?status=live', FALLBACK)).toBe('/domains?status=live');
  });

  /**
   * Following one of these after a credential is accepted is an open redirect
   * that hands a freshly authenticated operator to somebody else's site. The
   * check is a real URL resolution, because the WHATWG parser strips tab, CR and
   * LF *before* resolving — so a value that reads as a path to `startsWith`
   * resolves to another origin.
   */
  it.each([
    '//evil.example.com',
    'https://evil.example.com',
    '/\t/evil.example.com',
    '\\evil.example.com',
    'tenants',
    undefined,
  ])('refuses %j', (value) => {
    expect(parseRedirectPath(value, FALLBACK)).toBe(FALLBACK);
  });

  /**
   * The credential screen is not a destination: sending an operator back to the
   * door they just came through would loop them.
   */
  it('refuses the credential screen itself', () => {
    expect(parseRedirectPath('/credential', FALLBACK)).toBe(FALLBACK);
  });
});

describe('isCredentialPath', () => {
  it('lets the credential form through, or nobody could ever present one', () => {
    expect(isCredentialPath(routes.credential())).toBe(true);
  });

  it.each([routes.tenants(), routes.domains(), routes.webhooks(), '/'])('gates %s', (pathname) => {
    expect(isCredentialPath(pathname)).toBe(false);
  });
});
