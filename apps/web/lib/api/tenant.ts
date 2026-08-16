import 'server-only';

import {
  BRANDING_UPLOAD_FIELD,
  TenantBrandingSchema,
  TenantDomainListResponseSchema,
  TenantDomainSchema,
  TenantLifecycleResponseSchema,
  TenantPublicResponseSchema,
  TenantResponseSchema,
  type BrandingAssetKind,
  type TenantBranding,
  type TenantDomain,
  type TenantDomainCreateInput,
  type TenantLifecycleResponse,
  type TenantPublicResponse,
  type TenantResponse,
  type TenantUpdateInput,
} from '@whatsappcrm/contracts';
import { apiRequest } from '@/lib/api/http';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * The tenant singleton, its lifecycle, its branding assets and its domains. No
 * component calls `fetch`; it calls one of these, so each response is validated
 * against the contract in exactly one place.
 *
 * ## Four surfaces, deliberately not one endpoint
 *
 * They answer different questions and are gated differently, and merging them
 * would mean a principal who may read the workspace name has to be refused the
 * whole call:
 *
 *   - the **record** (`GET`/`PATCH /tenant`) is identity and branding — ADR
 *     0002's, readable by any session, written with `branding:write`;
 *   - the **lifecycle** (`GET /tenant/lifecycle`) is plan state and usage —
 *     0009's, behind `tenant:settings`, and what the plan panel renders;
 *   - the **assets** (`PUT`/`DELETE /tenant/branding/{kind}`) carry bytes;
 *   - the **domains** are their own resource with their own permission,
 *     `domain:write`, because DNS control decides where every invite and
 *     password-reset link in the tenant is sent.
 *
 * ## Why `getPublicTenant` is not an authenticated request
 *
 * The sign-in screen has to be themeable before anybody has a session, so
 * `GET /v1/tenant/public` is the one tenant read that goes through `apiRequest`
 * directly. It takes **no parameters of any kind** — the host is the only input,
 * and a tenant identifier on it would hand an anonymous caller an enumeration
 * oracle.
 *
 * ## Why nothing here is cached
 *
 * `/v1/tenant/public` is the *same URL for every tenant* — the tenant is the
 * *host*. A Next data cache or `fetch` cache keyed on URL alone is a direct
 * cross-tenant leak: one tenant's logo and colours served under another's
 * domain, which is the highest-severity bug this feature can produce and is
 * invisible in development, where there is one tenant. `apiRequest` already
 * sends `cache: 'no-store'` on every call and this module adds nothing that
 * would override it. When a cache is eventually wanted, the hostname belongs in
 * the key and a branding write has to invalidate it.
 */

const TENANT_PATH = '/v1/tenant';
const TENANT_PUBLIC_PATH = '/v1/tenant/public';
const TENANT_LIFECYCLE_PATH = '/v1/tenant/lifecycle';
const TENANT_DOMAINS_PATH = '/v1/tenant/domains';

/** Branding for the current host, with no session. Used by the root layout. */
export async function getPublicTenant(): Promise<TenantPublicResponse> {
  return TenantPublicResponseSchema.parse(
    await apiRequest({ method: 'GET', path: TENANT_PUBLIC_PATH }),
  );
}

export async function getTenant(): Promise<TenantResponse> {
  return TenantResponseSchema.parse(
    await authenticatedRequest({ method: 'GET', path: TENANT_PATH }),
  );
}

/**
 * Partial by construction: the contract's every field is optional, so a form
 * that only edits the name never has to send branding back and cannot clobber a
 * colour it did not show.
 */
export async function updateTenant(input: TenantUpdateInput): Promise<TenantResponse> {
  return TenantResponseSchema.parse(
    await authenticatedRequest({ method: 'PATCH', path: TENANT_PATH, body: input }),
  );
}

export async function getTenantLifecycle(): Promise<TenantLifecycleResponse> {
  return TenantLifecycleResponseSchema.parse(
    await authenticatedRequest({ method: 'GET', path: TENANT_LIFECYCLE_PATH }),
  );
}

/**
 * `PUT /v1/tenant/branding/{kind}` — multipart, field `file`.
 *
 * `PUT`, not `POST`: there is exactly one logo and one favicon per tenant, and
 * replacing either is idempotent. The caller has already checked the file against
 * `BRANDING_ASSET_LIMITS` so an oversize or unsupported one is refused before the
 * upload is spent; that is not this check's substitute — the API applies the same
 * limits again and sniffs the bytes rather than trusting the declared type.
 */
export async function uploadBrandingAsset(
  kind: BrandingAssetKind,
  file: File,
): Promise<TenantBranding> {
  const body = new FormData();

  body.append(BRANDING_UPLOAD_FIELD, file);

  return TenantBrandingSchema.parse(
    await authenticatedRequest({ method: 'PUT', path: `${TENANT_PATH}/branding/${kind}`, body }),
  );
}

/** `DELETE /v1/tenant/branding/{kind}` — back to the product name. */
export async function deleteBrandingAsset(kind: BrandingAssetKind): Promise<void> {
  await authenticatedRequest({ method: 'DELETE', path: `${TENANT_PATH}/branding/${kind}` });
}

export async function listTenantDomains(): Promise<readonly TenantDomain[]> {
  const response = await authenticatedRequest({ method: 'GET', path: TENANT_DOMAINS_PATH });

  return TenantDomainListResponseSchema.parse(response).items;
}

export async function createTenantDomain(input: TenantDomainCreateInput): Promise<TenantDomain> {
  return TenantDomainSchema.parse(
    await authenticatedRequest({ method: 'POST', path: TENANT_DOMAINS_PATH, body: input }),
  );
}

/**
 * `POST /v1/tenant/domains/{id}/verify`.
 *
 * A failed check is **200 with the domain**, not an error envelope: nothing went
 * wrong with the request, and "the TXT record is not there yet" is a state on the
 * resource. The caller reads `verification.lastFailureReason` off the row it gets
 * back rather than catching anything.
 */
export async function verifyTenantDomain(domainId: string): Promise<TenantDomain> {
  return TenantDomainSchema.parse(
    await authenticatedRequest({
      method: 'POST',
      path: `${TENANT_DOMAINS_PATH}/${domainId}/verify`,
    }),
  );
}

export async function setPrimaryTenantDomain(domainId: string): Promise<TenantDomain> {
  return TenantDomainSchema.parse(
    await authenticatedRequest({
      method: 'POST',
      path: `${TENANT_DOMAINS_PATH}/${domainId}/primary`,
    }),
  );
}

export async function deleteTenantDomain(domainId: string): Promise<void> {
  await authenticatedRequest({ method: 'DELETE', path: `${TENANT_DOMAINS_PATH}/${domainId}` });
}
