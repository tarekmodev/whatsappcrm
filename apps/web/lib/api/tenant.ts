import 'server-only';

import {
  TenantLifecycleResponseSchema,
  TenantResponseSchema,
  type TenantLifecycleResponse,
  type TenantResponse,
  type TenantUpdateInput,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * The tenant's own record and its lifecycle. `GET`/`PATCH /api/v1/tenant` are
 * ADR 0002's; `GET /api/v1/tenant/lifecycle` is 0009's, and it is the one the
 * plan panel renders.
 *
 * Two endpoints rather than one because they answer different questions and are
 * gated differently: the record is identity and branding, readable by any
 * session, while the lifecycle is plan state and usage behind `tenant:settings`.
 * Merging them would mean a principal who may read the workspace name has to be
 * refused the whole call.
 */

const TENANT_PATH = '/v1/tenant';
const TENANT_LIFECYCLE_PATH = '/v1/tenant/lifecycle';

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
