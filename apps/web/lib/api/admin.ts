import 'server-only';

import {
  AdminPendingDomainListResponseSchema,
  AdminTenantLifecycleEventSchema,
  AdminTenantLifecycleResponseSchema,
  AdminWebhookEventReplayResponseSchema,
  DeactivatedTenantResponseSchema,
  type AdminDomainStatus,
  type AdminPendingDomain,
  type AdminTenantLifecycleEvent,
  type AdminTenantLifecycleResponse,
  type AdminWebhookEventReplayResponse,
  type CursorPage,
  type DeactivatedTenantResponse,
} from '@whatsappcrm/contracts';
import { ApiRequestError, apiRequest, type ApiRequest } from '@/lib/api/http';
import { parseCursorPage } from '@/lib/api/parse';
import { ActionRefusedError } from '@/lib/actions/run-action';
import { readPlatformCredential, redirectToAdminSignIn } from '@/lib/admin/platform-credential';
import { webEnv } from '@/lib/config/env';
import { content } from '@/content/en';

/**
 * `/api/v1/admin/*` — everything the platform operator's console reads and
 * writes. No component calls `fetch`; it calls one of these, so each response is
 * validated against the contract in exactly one place.
 *
 * ## Every call is made by *this process*, never by the browser
 *
 * The tenant console's transport forwards the caller's session cookie and lets
 * the browser talk to the API directly where it has to (`auth-browser.ts`). This
 * one cannot: the credential is a shared bearer token, and a token the browser
 * can send is a token the browser holds. Every function here runs in a server
 * component or a server action, reads the cookie through
 * `readPlatformCredential`, and writes the `Authorization` header itself.
 *
 * ## What the admin API actually exposes today
 *
 * Worth stating, because the shape of this console is decided by it rather than
 * by the design reference. Reading the four admin controllers, the whole surface
 * is:
 *
 * | Route                                                  | What it gives |
 * | ------------------------------------------------------ | ------------- |
 * | `GET /admin/domains?status=`                            | the custom-domain queue, across tenants |
 * | `POST /admin/tenants/{slug}/domains/{host}/activate`    | attach / detach at the edge |
 * | `GET /admin/tenants/{slug}/lifecycle`                   | one tenant's trail, **with `reason`** |
 * | `POST /admin/tenants/{slug}/deactivate`                 | suspend |
 * | `POST /admin/tenants/{slug}/reactivate`                 | its inverse |
 * | `POST /admin/tenants/{slug}/cancel` / `/delete`         | end a subscription / schedule a purge |
 * | `POST /admin/tenants` (provision)                       | create a tenant |
 * | `POST /admin/webhook-events/{id}/replay`                | unpark one inbound event |
 * | `POST /admin/tenants/{slug}/whatsapp/…`                 | connect a WABA on a tenant's behalf |
 *
 * **There is no `GET /admin/tenants` and no `GET /admin/tenants/{slug}`.** Every
 * read of a tenant's *state* on this surface is a by-product of a write, and the
 * only cross-tenant list is the domain queue. That is why the console looks a
 * tenant up by slug rather than paging a table, and why there is no plan, usage
 * or MRR anywhere in it: those fields exist on `GET /tenant/lifecycle`, which is
 * tenant-scoped and authenticated by a tenant session an operator does not have.
 *
 * The three writes this module deliberately omits — provision, cancel and
 * delete — are out of TAR-804's scope and destructive in a way an operator
 * console should not grow by accident. They are in the table because the next
 * story to want them should know they are already there.
 */

const ADMIN_PATH = '/v1/admin';

/**
 * Refuses every call on this surface while the console is reading fixtures.
 *
 * `apiRequest` switches to `lib/api/mock/handlers.ts` when
 * `NEXT_PUBLIC_USE_MOCK_API` is on — which the repository's `.env.example` ships
 * as the default — and that router cannot answer here. It is not a matter of
 * missing handlers: every route in it resolves a stubbed **tenant principal**
 * and checks a tenant permission, and this surface has neither. A platform
 * operator is not a user inside any tenant, which is the whole reason
 * `PlatformAdminGuard` exists.
 *
 * So the console says so once, in a sentence naming the two variables to change,
 * rather than letting every screen fail with "we could not save that" and a mock
 * request id. `ActionRefusedError` is what carries user-facing copy out of a
 * failure — the sign-in screen refuses before the form, and this covers any other
 * way in.
 */
function refuseMockTransport(): void {
  if (webEnv.useMockApi) {
    throw new ActionRefusedError(content.platformAdmin.signIn.mockApiBody);
  }
}

/**
 * The transport every call above goes through, and the reason the credential
 * cannot be forgotten.
 *
 * Three things a resource function should not each have to remember:
 *
 *   1. **Reads the credential, and refuses without one.** A missing cookie is a
 *      redirect to the credential form rather than an anonymous call the API
 *      would answer `401` to anyway.
 *   2. **Writes the `Authorization` header.** `apiRequest` merges the caller's
 *      headers before its own tenant-routing pair, and neither of those names
 *      `authorization`, so nothing downstream can replace it.
 *   3. **Turns a rejected credential into the credential form.** `PLATFORM_ADMIN_TOKEN`
 *      can be rotated between the cookie being set and the call being made, and
 *      that answer is "present it again", not an error page.
 */
async function adminRequest(request: ApiRequest): Promise<unknown> {
  refuseMockTransport();

  const credential = (await readPlatformCredential()) ?? (await redirectToAdminSignIn());

  const outcome = await attempt(request, credential);

  // Outside the `try`, per Next's rule for `redirect`: inside it, the navigation
  // it throws would be caught as though it were a failed request.
  return outcome.status === 'ok' ? outcome.value : await redirectToAdminSignIn();
}

type Outcome = { readonly status: 'ok'; readonly value: unknown } | { readonly status: 'rejected' };

async function attempt(request: ApiRequest, credential: string): Promise<Outcome> {
  try {
    return {
      status: 'ok',
      value: await apiRequest({
        ...request,
        headers: { authorization: `Bearer ${credential}`, ...request.headers },
      }),
    };
  } catch (error) {
    if (isCredentialRejected(error)) {
      return { status: 'rejected' };
    }

    // Everything else belongs to the caller: a 404 for a mistyped slug and a 409
    // for an event that was never parked need different copy, and swallowing
    // them here would flatten the difference.
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
 * admin surface that names no tenant: it needs no slug the operator has not typed
 * yet, and answering it proves the guard accepted the token. A write would prove
 * the same thing by doing something.
 *
 * Returns whether it was accepted rather than throwing, because the caller is a
 * sign-in form and "that token is not valid" is a field error, not an incident.
 * Anything that is *not* a refusal — the API being down, a malformed response —
 * still throws, because telling an operator their token is wrong when the API is
 * unreachable would send them looking in the wrong place.
 */
export async function verifyPlatformCredential(credential: string): Promise<boolean> {
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
 * operator's copy of `GET /tenant/lifecycle/events`.
 *
 * This is also the only read of a tenant's *current* status the admin API
 * offers: the newest row's `toStatus` is where the tenant is now. See
 * `tenant-presentation.ts`, which does that derivation once so no component
 * repeats it.
 *
 * A `404` here means the slug names no tenant, which is the answer to "did I
 * type that right" and is left to the caller to render.
 */
export async function listTenantLifecycleEvents(
  slug: string,
  cursor?: string,
): Promise<CursorPage<AdminTenantLifecycleEvent>> {
  const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;

  return parseCursorPage(
    AdminTenantLifecycleEventSchema,
    await adminRequest({
      method: 'GET',
      path: `${ADMIN_PATH}/tenants/${encodeURIComponent(slug)}/lifecycle${query}`,
    }),
  );
}

/**
 * Suspends a tenant: its agents stop reaching their data on their very next
 * query, including through open sessions and in-flight background jobs.
 *
 * `reason` is free text for the trail and is **never rendered to the tenant** —
 * ADR 0009's security section, and the reason the operator's read of the trail
 * carries a column the tenant's own does not.
 */
export async function suspendTenant(
  slug: string,
  reason?: string,
): Promise<DeactivatedTenantResponse> {
  return DeactivatedTenantResponseSchema.parse(
    await adminRequest({
      method: 'POST',
      path: `${ADMIN_PATH}/tenants/${encodeURIComponent(slug)}/deactivate`,
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
    await adminRequest({
      method: 'POST',
      path: `${ADMIN_PATH}/tenants/${encodeURIComponent(slug)}/reactivate`,
      body: {},
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
export async function listPendingDomains(
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
export async function activateTenantDomain(slug: string, hostname: string): Promise<void> {
  await adminRequest({
    method: 'POST',
    path: domainActionPath(slug, hostname, 'activate'),
    body: {},
  });
}

/** The inverse, once the hostname has been removed from the web service. */
export async function deactivateTenantDomain(slug: string, hostname: string): Promise<void> {
  await adminRequest({
    method: 'POST',
    path: domainActionPath(slug, hostname, 'deactivate'),
    body: {},
  });
}

function domainActionPath(
  slug: string,
  hostname: string,
  action: 'activate' | 'deactivate',
): string {
  const tenant = encodeURIComponent(slug);

  return `${ADMIN_PATH}/tenants/${tenant}/domains/${encodeURIComponent(hostname)}/${action}`;
}

// ---------------------------------------------------------------------------
// Parked webhook events
// ---------------------------------------------------------------------------

/**
 * Resets a parked inbound event so the next sweep reprocesses it (TAR-94).
 *
 * The event id is the identity of the request, and there is no list endpoint to
 * pick one from — the flagship parked event is a number connected *after* its
 * customers messaged it, so the row names no tenant and could not be listed under
 * one. The operator arrives with an id from `webhook_events`, which is exactly
 * how the runbook's query hands it to them.
 *
 * A repeat is a `409`, not a quiet `200`: answering success on an event that was
 * already unparked would tell an operator mid-incident that they had recovered a
 * message when they had not. That refusal names the status, and the console shows
 * it verbatim.
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
