import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CUSTOM_DOMAINS_PER_TENANT,
  type TenantDomain,
  type TenantDomainListResponse,
  type TenantPublicResponse,
  type TenantResponse,
  type TenantRole,
} from '@whatsappcrm/contracts';

/**
 * The tenant, branding and domain surface of the mock transport (TAR-29).
 *
 * These are the acceptance criteria for the feature, not decoration. Four of them
 * are properties a broken implementation satisfies right up until it is deployed
 * to a second tenant:
 *
 *   - one tenant's branding is never observable under another's context;
 *   - a hostname another tenant holds is refused **without saying who holds it**;
 *   - the platform subdomain can never be removed;
 *   - primary requires a hostname that is both proved **and** actually served,
 *     because invite and password-reset links are mailed to it.
 *
 * `server-only` throws outside a React Server Component, and `next/headers` needs
 * a request scope — both are stubbed so these stay plain unit tests.
 */

vi.mock('server-only', () => ({}));

let currentRole: TenantRole = 'admin';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'wac_role_stub' ? { name, value: currentRole } : undefined),
    }),
}));

const { handleMockRequest } = await import('./handlers');
const { resetMockState, mockState } = await import('./store');
const { MOCK_TENANT_ID, OTHER_TENANT_ID, MOCK_TENANTS, MOCK_TENANT_DOMAINS } =
  await import('./fixtures');
const { ApiRequestError } = await import('@/lib/api/http');

const OTHER_TENANT = MOCK_TENANTS.find((tenant) => tenant.id === OTHER_TENANT_ID);

/**
 * Read out of the fixtures rather than written down here. A hostname literal
 * would silently stop testing anything the next time the seed is renamed — which
 * is exactly what happened when the other tenant became Southwind.
 */
const OTHER_TENANT_HOSTNAME = MOCK_TENANT_DOMAINS.find(
  (domain) => domain.tenantId === OTHER_TENANT_ID,
)?.hostname;

beforeEach(() => {
  resetMockState();
  currentRole = 'admin';
});

async function getTenant(): Promise<TenantResponse> {
  return (await handleMockRequest({ method: 'GET', path: '/v1/tenant' })) as TenantResponse;
}

async function listDomains(): Promise<readonly TenantDomain[]> {
  const response = (await handleMockRequest({
    method: 'GET',
    path: '/v1/tenant/domains',
  })) as TenantDomainListResponse;

  return response.items;
}

async function addDomain(hostname: string): Promise<TenantDomain> {
  return (await handleMockRequest({
    method: 'POST',
    path: '/v1/tenant/domains',
    body: { hostname },
  })) as TenantDomain;
}

/**
 * Proves the hostname and then attaches it at the edge.
 *
 * The second half has **no tenant-facing route on purpose** — it is the platform
 * operator's step, and writing to the store directly is the honest way to say
 * so. A mock route that let the console activate its own domain would
 * misrepresent the half of the split the tenant does not hold, which is the
 * whole isolation argument for custom domains.
 */
async function addLiveDomain(hostname: string): Promise<TenantDomain> {
  const claimed = await addDomain(hostname);

  await handleMockRequest({ method: 'POST', path: `/v1/tenant/domains/${claimed.id}/verify` });

  const stored = mockState().tenantDomains.get(claimed.id);

  if (stored === undefined) {
    throw new Error(`the mock store lost ${hostname} between claiming and activating it`);
  }

  mockState().tenantDomains.set(claimed.id, {
    ...stored,
    status: 'live',
    activatedAt: '2026-08-15T09:00:00.000Z',
  });

  return claimed;
}

describe('tenant branding isolation', () => {
  it('serves this tenant’s branding and never the other tenant’s', async () => {
    const tenant = await getTenant();

    expect(tenant.id).toBe(MOCK_TENANT_ID);
    expect(tenant.branding.productName).toBe('Northwind Support');
    // The second tenant is seeded with a deliberately unmistakable brand, so a
    // leak shows up as a wrong string rather than as a slightly different blue.
    expect(tenant.branding.primaryColor).not.toBe(OTHER_TENANT?.branding.primaryColor);
  });

  it('leaves the other tenant untouched when this one saves its branding', async () => {
    await handleMockRequest({
      method: 'PATCH',
      path: '/v1/tenant',
      body: { branding: { primaryColor: '#123456', productName: 'Renamed' } },
    });

    // The isolation criterion, in the only form a fixture layer can state it:
    // one tenant's write did not move the other tenant's row.
    expect(mockState().tenants.get(OTHER_TENANT_ID)?.branding.primaryColor).toBe(
      OTHER_TENANT?.branding.primaryColor,
    );
    expect(mockState().tenants.get(OTHER_TENANT_ID)?.branding.productName).toBe(
      OTHER_TENANT?.branding.productName,
    );
  });

  it('publishes only name, id and branding to an anonymous caller', async () => {
    const response = (await handleMockRequest({
      method: 'GET',
      path: '/v1/tenant/public',
    })) as TenantPublicResponse;

    // No slug, no status, no domains, no trial date: this is what the sign-in
    // screen may see, and it is reachable without a session.
    expect(Object.keys(response).sort()).toEqual(['branding', 'id', 'name']);
  });

  it('clears the support email when it is sent as null, and leaves it alone when omitted', async () => {
    await handleMockRequest({
      method: 'PATCH',
      path: '/v1/tenant',
      body: { branding: { supportEmail: null } },
    });

    expect((await getTenant()).branding.supportEmail).toBeNull();

    await handleMockRequest({
      method: 'PATCH',
      path: '/v1/tenant',
      body: { branding: { productName: 'Unrelated change' } },
    });

    expect((await getTenant()).branding.supportEmail).toBeNull();
  });

  it('refuses a branding write from a role without branding:write', async () => {
    currentRole = 'supervisor';

    await expect(
      handleMockRequest({ method: 'PATCH', path: '/v1/tenant', body: { name: 'Nope' } }),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe('branding assets', () => {
  function pngOf(bytes: number): File {
    const file = new File(['x'], 'logo.png', { type: 'image/png' });

    Object.defineProperty(file, 'size', { value: bytes });

    return file;
  }

  async function upload(file: File): Promise<unknown> {
    const body = new FormData();

    body.append('file', file);

    return handleMockRequest({ method: 'PUT', path: '/v1/tenant/branding/logo', body });
  }

  it('publishes a relative, cache-busted path rather than an absolute URL', async () => {
    await upload(pngOf(2048));

    const { logo } = (await getTenant()).branding;

    // Absolute would name whichever host existed at write time and make the
    // browser fetch it cross-origin under a custom domain.
    expect(logo?.path).toMatch(/^\/api\/v1\/tenant\/branding\/logo\?v=\d+$/);
    expect(logo?.sizeBytes).toBe(2048);
  });

  it('refuses a file over the published cap', async () => {
    await expect(upload(pngOf(5 * 1024 * 1024))).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('refuses SVG, the one image type that can carry script', async () => {
    const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });

    await expect(upload(svg)).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('returns to the wordmark fallback when the asset is removed', async () => {
    await upload(pngOf(1024));
    await handleMockRequest({ method: 'DELETE', path: '/v1/tenant/branding/logo' });

    expect((await getTenant()).branding.logo).toBeNull();
  });
});

describe('custom domains', () => {
  it('always leaves the tenant a platform subdomain it cannot remove', async () => {
    const platform = (await listDomains()).find((domain) => domain.kind === 'platform');

    expect(platform).toBeDefined();
    await expect(
      handleMockRequest({ method: 'DELETE', path: `/v1/tenant/domains/${platform?.id ?? ''}` }),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('issues a TXT challenge and a routing record for a new claim', async () => {
    const created = await addDomain('help.example.com');

    expect(created.status).toBe('pending_verification');
    expect(created.verification?.recordName).toBe('_whatsappcrm-challenge.help.example.com');
    expect(created.verification?.recordValue).toMatch(
      /^whatsappcrm-domain-verification=[0-9a-f]{32}$/,
    );
    expect(created.routing?.recordName).toBe('help.example.com');
  });

  it('treats re-adding a hostname this tenant already holds as idempotent', async () => {
    const first = await addDomain('help.example.com');
    const second = await addDomain('help.example.com');

    expect(second.id).toBe(first.id);
    expect(
      (await listDomains()).filter((item) => item.hostname === 'help.example.com'),
    ).toHaveLength(1);
  });

  it('refuses a hostname another tenant holds without naming the holder', async () => {
    const theirs = OTHER_TENANT_HOSTNAME ?? '';

    expect(theirs).not.toBe('');
    await expect(addDomain(theirs)).rejects.toMatchObject({ code: 'conflict' });

    // The refusal must carry nothing about who holds it — the API cannot read
    // that row either, and a message that named it would be the leak.
    await addDomain(theirs).catch((error: unknown) => {
      const { message } = error as InstanceType<typeof ApiRequestError>;

      expect(message).not.toContain(OTHER_TENANT?.name ?? 'Southwind');
      expect(message).not.toContain(OTHER_TENANT?.branding.productName ?? 'Helpdesk');
      expect(message).not.toContain(OTHER_TENANT_ID);
    });
  });

  it('refuses a hostname that is not a hostname', async () => {
    await expect(addDomain('https://help.example.com')).rejects.toBeInstanceOf(ApiRequestError);
    await expect(addDomain('192.168.0.1')).rejects.toBeInstanceOf(ApiRequestError);
    // Non-ASCII is refused rather than silently converted: a homograph accepted
    // quietly is a phishing host we would issue a certificate for.
    await expect(addDomain('hëlp.example.com')).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('caps the tenant at the published number of custom domains', async () => {
    for (let index = 0; index < MAX_CUSTOM_DOMAINS_PER_TENANT - 1; index += 1) {
      await addDomain(`extra${index}.example.com`);
    }

    // One custom domain is already seeded, so the loop above fills the quota.
    await expect(addDomain('one-too-many.example.com')).rejects.toMatchObject({
      code: 'plan_limit_exceeded',
    });
  });

  it('verifies a claim and clears its failure reason', async () => {
    const pending = (await listDomains()).find((domain) => domain.kind === 'custom');
    const checked = (await handleMockRequest({
      method: 'POST',
      path: `/v1/tenant/domains/${pending?.id ?? ''}/verify`,
    })) as TenantDomain;

    expect(checked.verifiedAt).not.toBeNull();
    expect(checked.verification?.lastFailureReason).toBeNull();
  });

  it('answers a failed check with the domain and a reason, not an error', async () => {
    const unverifiable = await addDomain('unverifiable.example.com');
    const checked = (await handleMockRequest({
      method: 'POST',
      path: `/v1/tenant/domains/${unverifiable.id}/verify`,
    })) as TenantDomain;

    // Nothing went wrong with the *request*; the record simply is not there.
    expect(checked.verifiedAt).toBeNull();
    expect(checked.verification?.lastFailureReason).toBe('record_not_found');
  });

  it('refuses to make an unproved hostname primary', async () => {
    const claimed = await addDomain('help.example.com');

    await expect(
      handleMockRequest({ method: 'POST', path: `/v1/tenant/domains/${claimed.id}/primary` }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('refuses to make a proved hostname primary before the edge serves it', async () => {
    // Verified is not enough. Attaching is a manual operator step, and the
    // primary is where invite and password-reset links are mailed — promoting
    // inside that window aims live tokens at a host with no route.
    const claimed = await addDomain('help.example.com');

    await handleMockRequest({ method: 'POST', path: `/v1/tenant/domains/${claimed.id}/verify` });

    await expect(
      handleMockRequest({ method: 'POST', path: `/v1/tenant/domains/${claimed.id}/primary` }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('moves primary in one step, leaving exactly one', async () => {
    const claimed = await addLiveDomain('help.example.com');

    await handleMockRequest({ method: 'POST', path: `/v1/tenant/domains/${claimed.id}/primary` });

    expect((await listDomains()).filter((domain) => domain.isPrimary)).toHaveLength(1);
  });

  it('returns primary to the platform subdomain when the primary is removed', async () => {
    const claimed = await addLiveDomain('help.example.com');

    await handleMockRequest({ method: 'POST', path: `/v1/tenant/domains/${claimed.id}/primary` });
    await handleMockRequest({ method: 'DELETE', path: `/v1/tenant/domains/${claimed.id}` });

    const primary = (await listDomains()).find((domain) => domain.isPrimary);

    // A tenant is never left without a primary: invite and reset links have to
    // be addressed to something.
    expect(primary?.kind).toBe('platform');
  });

  it('never lists another tenant’s domains', async () => {
    expect((await listDomains()).map((domain) => domain.hostname)).not.toContain(
      OTHER_TENANT_HOSTNAME,
    );
  });

  it('refuses every domain route for a role without domain:write', async () => {
    currentRole = 'supervisor';

    await expect(
      handleMockRequest({ method: 'GET', path: '/v1/tenant/domains' }),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });
});
