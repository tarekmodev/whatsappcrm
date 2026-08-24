import 'server-only';

import {
  AdminPendingDomainListResponseSchema,
  AdminTenantLifecycleEventSchema,
  AdminTenantLifecycleResponseSchema,
  AdminWebhookEventReplayResponseSchema,
  DeactivatedTenantResponseSchema,
  ProvisionedTenantResponseSchema,
  type AdminDomainStatus,
  type AdminPendingDomain,
  type AdminTenantLifecycleEvent,
  type AdminTenantLifecycleResponse,
  type AdminWebhookEventReplayResponse,
  type CursorPage,
  type DeactivatedTenantResponse,
  type ProvisionTenantInput,
  type ProvisionedTenantResponse,
} from '@whatsappcrm/contracts';
import { ApiRequestError, apiRequest, type ApiRequest } from '@/lib/api/http';
import { parseCursorPage } from '@/lib/api/parse';
import { ActionRefusedError } from '@/lib/actions/run-action';
import { webEnv } from '@/lib/config/env';
import { CredentialRefusedError, readCredential } from '~/lib/credential';
import { content } from '~/content/en';

/**
 * `/api/v1/admin/*` — everything the operator console reads and writes. No
 * component calls `fetch`; it calls one of these, so each response is validated
 * against the contract in exactly one place.
 *
 * ## Every call is made by this process, never by the browser
 *
 * The credential is a shared bearer token, and a token the browser can send is a
 * token the browser holds. Every function here runs in a server component or a
 * server action, reads the cookie through `readCredential`, and writes the
 * `Authorization` header itself. `next.config.mjs` deliberately ships no `/api`
 * rewrite, so there is no browser path to the API from this origin at all.
 *
 * ## The whole surface, and the reads that are missing
 *
 * | Route                                                  | What it gives |
 * | ------------------------------------------------------ | ------------- |
 * | `POST /admin/tenants`                                   | provision |
 * | `GET  /admin/tenants/{slug}/lifecycle`                  | one tenant's trail, **with `reason`** |
 * | `POST /admin/tenants/{slug}/deactivate`                 | suspend |
 * | `POST /admin/tenants/{slug}/reactivate`                 | its inverse |
 * | `POST /admin/tenants/{slug}/cancel`                     | end a subscription |
 * | `POST /admin/tenants/{slug}/delete`                     | schedule a purge, or expedite it |
 * | `GET  /admin/domains?status=`                           | the domain queue, across tenants |
 * | `POST /admin/tenants/{slug}/domains/{host}/(de)activate`| attach / detach at the edge |
 * | `POST /admin/webhook-events/{id}/replay`                | unpark one inbound event |
 *
 * **There is no `GET /admin/tenants` and no `GET /admin/tenants/{slug}.`** Every
 * read of a tenant's *state* here is a by-product of a write, and the only
 * cross-tenant list is the domain queue. That is why the console addresses
 * tenants by slug, and why there is no plan, usage or MRR anywhere in it — those
 * fields live on `GET /tenant/lifecycle`, which a tenant session authenticates
 * and an operator does not have. 0002 spec §2.0 records the same finding.
 */

const ADMIN_PATH = '/v1/admin';

/**
 * Refuses every call while the console is pointed at the fixture transport.
 *
 * `apiRequest` switches to `apps/web`'s mock router when
 * `NEXT_PUBLIC_USE_MOCK_API` is on, and that router cannot answer here: every
 * route in it resolves a stubbed **tenant principal** and checks a tenant
 * permission, and this surface has neither. So the console says so once, naming
 * the variable to change, rather than failing per screen with a mock request id.
 */
function refuseMockTransport(): void {
  if (webEnv.useMockApi) {
    throw new ActionRefusedError(content.credential.mockApiBody);
  }
}

/**
 * The transport every call goes through, and the reason the credential cannot be
 * forgotten.
 *
 * Three things a resource function should not each have to remember: read the
 * credential and refuse without one; write the `Authorization` header; and turn
 * a *refused* credential into `CredentialRefusedError` rather than a redirect,
 * because an operator whose token was rotated mid-incident needs to be told.
 */
async function adminRequest(request: ApiRequest): Promise<unknown> {
  refuseMockTransport();

  const credential = await readCredential();

  if (credential === null) {
    throw new CredentialRefusedError();
  }

  return await send(request, credential);
}

async function send(request: ApiRequest, credential: string): Promise<unknown> {
  try {
    return await apiRequest({
      ...request,
      // The credential last, so nothing a caller passes can replace it. No caller
      // in this file passes headers; the order is what keeps that true if one does.
      headers: { ...request.headers, authorization: `Bearer ${credential}` },
    });
  } catch (error) {
    if (isCredentialRejected(error)) {
      throw new CredentialRefusedError();
    }

    // Everything else belongs to the caller: a 404 for a mistyped slug and a 409
    // for an event that was never parked need different copy, and swallowing them
    // here would flatten the difference.
    throw error;
  }
}

/**
 * The guard's one refusal. It answers the same `unauthenticated` for an absent
 * header, a wrong scheme, a wrong token and an unconfigured environment, on
 * purpose — so the response cannot be used to work out which — and the console
 * treats all four the same way for the same reason.
 */
function isCredentialRejected(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'unauthenticated';
}

/**
 * Verifies a credential without changing anything.
 *
 * `GET /admin/domains` is the probe because it is the only **read** on the whole
 * surface that names no tenant: it needs no slug the operator has not typed yet,
 * and answering it proves the guard accepted the token. A write would prove the
 * same thing by doing something.
 *
 * Returns whether it was accepted rather than throwing, because the caller is a
 * credential form and "that was refused" is a field error, not an incident.
 * Anything that is *not* a refusal — the API being unreachable — still throws:
 * telling an operator their token is wrong when the API is down sends them
 * looking in the wrong place.
 */
export async function verifyCredential(credential: string): Promise<boolean> {
  refuseMockTransport();

  try {
    await apiRequest({
      method: 'GET',
      path: `${ADMIN_PATH}/domains`,
      headers: { authorization: `Bearer ${credential}` },
    });

    return true;
  } catch (error) {
    if (isCredentialRejected(error)) {
      return false;
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

/**
 * One tenant's lifecycle trail, newest first, **including `reason`** — the
 * operator's copy of `GET /tenant/lifecycle/events`, and the one column the
 * tenant's own read does not get (ADR 0009).
 *
 * It is also the only read of a tenant's *current* status the API offers: the
 * newest row's `toStatus` is where the tenant is now. `tenant-presentation.ts`
 * does that derivation once so no component repeats it.
 */
export async function listTenantTrail(
  slug: string,
  cursor?: string,
): Promise<CursorPage<AdminTenantLifecycleEvent>> {
  const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;

  return parseCursorPage(
    AdminTenantLifecycleEventSchema,
    await adminRequest({
      method: 'GET',
      path: `${tenantPath(slug)}/lifecycle${query}`,
    }),
  );
}

/**
 * Provisions a tenant.
 *
 * **`201` and `200` are different outcomes**, and the caller has to be able to
 * tell them apart: `200` means a tenant already existed at that slug and nothing
 * changed. Treating the idempotent replay as a success is how an operator
 * concludes they created something they did not — so this returns the status
 * alongside the body rather than discarding it.
 */
export interface ProvisionOutcome {
  readonly created: boolean;
  readonly tenant: ProvisionedTenantResponse;
}

export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionOutcome> {
  const { status, body } = await adminRequestWithStatus({
    method: 'POST',
    path: `${ADMIN_PATH}/tenants`,
    body: input,
  });

  return { created: status === HTTP_CREATED, tenant: ProvisionedTenantResponseSchema.parse(body) };
}

const HTTP_CREATED = 201;

/**
 * Suspends a tenant: its agents stop reaching their data on their very next
 * query, including through open sessions and in-flight background jobs.
 *
 * `reason` is free text for the trail and is **never rendered to the tenant** —
 * ADR 0009's security section.
 */
export async function suspendTenant(
  slug: string,
  reason?: string,
): Promise<DeactivatedTenantResponse> {
  return DeactivatedTenantResponseSchema.parse(
    await adminRequest({
      method: 'POST',
      path: `${tenantPath(slug)}/deactivate`,
      body: reason === undefined ? {} : { reason },
    }),
  );
}

/**
 * Suspension's inverse. No data is re-provisioned — the tenant's rows were never
 * deleted — so access returns on the very next statement.
 */
export async function reactivateTenant(slug: string): Promise<AdminTenantLifecycleResponse> {
  return AdminTenantLifecycleResponseSchema.parse(
    await adminRequest({ method: 'POST', path: `${tenantPath(slug)}/reactivate`, body: {} }),
  );
}

/** Ends a tenant's subscription on its behalf. It keeps access until the grace period ends. */
export async function cancelTenant(
  slug: string,
  reason?: string,
): Promise<AdminTenantLifecycleResponse> {
  return AdminTenantLifecycleResponseSchema.parse(
    await adminRequest({
      method: 'POST',
      path: `${tenantPath(slug)}/cancel`,
      body: reason === undefined ? {} : { reason },
    }),
  );
}

/**
 * Schedules a deletion, or forces one.
 *
 * Without `force` it is cancel with a grace period, reaching `suspended`, purged
 * when the retention window elapses. With `force` it goes straight to
 * `suspended` with `purgeAt` moved to now — the right-to-erasure path, and the
 * only way to shorten the window.
 */
export async function deleteTenant(
  slug: string,
  input: { force: boolean; reason?: string },
): Promise<AdminTenantLifecycleResponse> {
  return AdminTenantLifecycleResponseSchema.parse(
    await adminRequest({
      method: 'POST',
      path: `${tenantPath(slug)}/delete`,
      body: input.reason === undefined ? { force: input.force } : input,
    }),
  );
}

// ---------------------------------------------------------------------------
// Custom domains
// ---------------------------------------------------------------------------

/**
 * The operator's activation queue: domains a tenant has proved it owns, waiting
 * to be attached at the edge (`docs/runbooks/custom-domains.md`).
 *
 * The one cross-tenant list on the whole admin surface, and it names the tenant
 * because an operator has to attach the hostname to the right environment's web
 * service. Nothing else about the tenant is exposed.
 */
export async function listDomainQueue(
  status: AdminDomainStatus,
): Promise<readonly AdminPendingDomain[]> {
  return AdminPendingDomainListResponseSchema.parse(
    await adminRequest({
      method: 'GET',
      path: `${ADMIN_PATH}/domains?status=${encodeURIComponent(status)}`,
    }),
  ).items;
}

/** Records that the hostname is attached at the edge with a certificate. */
export async function attachDomain(slug: string, hostname: string): Promise<void> {
  await adminRequest({ method: 'POST', path: domainPath(slug, hostname, 'activate'), body: {} });
}

/** The inverse, once the hostname has been removed from the web service. */
export async function detachDomain(slug: string, hostname: string): Promise<void> {
  await adminRequest({ method: 'POST', path: domainPath(slug, hostname, 'deactivate'), body: {} });
}

// ---------------------------------------------------------------------------
// Parked webhook events
// ---------------------------------------------------------------------------

/**
 * Resets a parked inbound event so the next sweep reprocesses it (TAR-94).
 *
 * The event id is the identity of the request, and there is no list endpoint to
 * pick one from — the flagship parked event is a number connected *after* its
 * customers messaged it, so the row names no tenant and could not be listed
 * under one. The operator arrives with an id from `webhook_events`.
 *
 * A repeat is a `409` naming the status the event is really in, and the console
 * shows that sentence verbatim: answering success on an event that was already
 * unparked would tell an operator mid-incident they had recovered a message when
 * they had not.
 */
export async function replayWebhookEvent(
  webhookEventId: string,
): Promise<AdminWebhookEventReplayResponse> {
  return AdminWebhookEventReplayResponseSchema.parse(
    await adminRequest({
      method: 'POST',
      path: `${ADMIN_PATH}/webhook-events/${encodeURIComponent(webhookEventId)}/replay`,
      body: {},
    }),
  );
}

function tenantPath(slug: string): string {
  return `${ADMIN_PATH}/tenants/${encodeURIComponent(slug)}`;
}

function domainPath(slug: string, hostname: string, action: 'activate' | 'deactivate'): string {
  return `${tenantPath(slug)}/domains/${encodeURIComponent(hostname)}/${action}`;
}

/**
 * Provisioning is the one call whose **status code is part of the answer**, and
 * `apiRequest` returns only the parsed body. Rather than widen that transport for
 * one caller, this makes the request the same way and keeps the response.
 *
 * It repeats the credential and the mock guard deliberately: a second path to the
 * API that skipped either would be the hole this module exists to close.
 */
async function adminRequestWithStatus(
  request: ApiRequest,
): Promise<{ status: number; body: unknown }> {
  refuseMockTransport();

  const credential = await readCredential();

  if (credential === null) {
    throw new CredentialRefusedError();
  }

  const response = await fetch(`${webEnv.serverApiBaseUrl}${request.path}`, {
    method: request.method,
    cache: 'no-store',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify(request.body),
  });

  if (!response.ok) {
    const { toApiRequestError } = await import('@/lib/api/error');

    const error = await toApiRequestError(response);

    throw isCredentialRejected(error) ? new CredentialRefusedError() : error;
  }

  return { status: response.status, body: await response.json() };
}
