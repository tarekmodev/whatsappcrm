import 'server-only';

import { cookies } from 'next/headers';
import type { TenantRole } from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import { ROLE_STUB_COOKIE_NAME, ROLE_STUB_HEADER, parseStubRole } from '@/lib/session/role-stub';

/**
 * ⚠️ INTERIM STUB (TAR-35) — the request-side half of `role-stub.ts`.
 *
 * Two readers of the same cookie, kept together so they cannot answer
 * differently: `resolveStubPrincipal` builds the principal the chrome shows, and
 * `roleStubHeaders` tells the API which principal to resolve for the call that
 * fills that chrome with data. Split apart, the console shows Priya and the API
 * answers as the tenant's first admin — which is exactly what TAR-366 reported.
 *
 * Separate from `stub-principal.ts` because the transport needs the cookie and
 * nothing else; importing that module would pull the whole mock fixture graph
 * into every real HTTP call.
 */

export async function readStubRole(): Promise<TenantRole> {
  const cookieStore = await cookies();

  return parseStubRole(cookieStore.get(ROLE_STUB_COOKIE_NAME)?.value);
}

/**
 * Names the selected stub role on a server-side call to the API, or nothing at
 * all when the stub is off.
 *
 * Gated twice, the same pair `setStubRoleAction` uses: the flag is off by default,
 * and production is refused outright regardless of it. With real sessions in play
 * this returns `{}`, so the header never exists to be trusted — and even if one
 * arrived, the API only reads it while its own `AUTH_STUB_ENABLED` is on, which
 * its environment schema refuses under `NODE_ENV=production`.
 *
 * Sent on every server-side call rather than only the authenticated ones, for the
 * reason the tenant pair is: a call site that has to remember is a call site that
 * eventually forgets.
 */
export async function roleStubHeaders(): Promise<Record<string, string>> {
  if (!webEnv.enableRoleStub || webEnv.isProduction) {
    return {};
  }

  return { [ROLE_STUB_HEADER]: await readStubRole() };
}
