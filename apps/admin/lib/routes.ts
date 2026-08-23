import { ADMIN_DOMAIN_QUERY_STATUSES, type AdminDomainStatus } from '@whatsappcrm/contracts';

/**
 * The operator console's route map. No route string is written anywhere else in
 * this app — a rename happens here and `pnpm typecheck` finds every caller.
 *
 * Its own map rather than an import from `apps/web`: these are a different app's
 * paths on a different origin, and the two must be free to move independently.
 * The one thing they share is the *shape* of this module, so a reader who knows
 * one knows the other.
 */
export const routes = {
  /**
   * The credential screen. `?next=` is where the operator was heading.
   *
   * `/credential`, not `/sign-in`, on the screen whose whole premise is that it
   * is not a sign-in page: there is no account, no password and no session, and a
   * path that says otherwise is the first thing an operator reads.
   */
  credential: (query?: CredentialQuery) =>
    withQuery('/credential', { [searchParamKeys.redirectTo]: query?.redirectTo }),
  /**
   * Where an operator arrives. Tenants rather than a dashboard, and that is
   * decided by the API rather than by taste: a dashboard would need cross-tenant
   * counts or revenue, and `/api/v1/admin/*` exposes neither (0002 spec §2.0).
   */
  tenants: () => '/tenants',
  /**
   * One tenant. Encoded, unlike an id-keyed route: a slug is *typed by an
   * operator*, so this is the one parameter here not already known to be safe.
   */
  tenant: (slug: string, query?: TenantQuery) =>
    withQuery(`/tenants/${encodeURIComponent(slug)}`, {
      [searchParamKeys.trailCursor]: query?.cursor,
    }),
  /** The custom-domain activation queue on a route of its own (0002 spec §2.8). */
  domains: (query?: DomainsQuery) =>
    withQuery('/domains', { [searchParamKeys.domainStatus]: query?.status }),
  /** Replaying a parked inbound event — a form, not a queue (§2.9). */
  webhooks: () => '/webhooks',
} as const;

/** Query keys are named once so a link and the page that reads it cannot drift. */
export const searchParamKeys = {
  /** Where the credential screen sends the operator afterwards. */
  redirectTo: 'next',
  /**
   * Which half of the domain queue is shown. Spelled as `AdminDomainQuerySchema`
   * names it, so the URL parameter and the query it becomes cannot drift.
   */
  domainStatus: 'status',
  /**
   * Which page of a tenant's audit trail is shown, spelled as
   * `CursorPageQuerySchema` names it. In the URL because a page of somebody's
   * trail is what an operator sends to a colleague mid-incident. Forward only —
   * the API publishes no previous cursor — so the way back is the bare route.
   */
  trailCursor: 'cursor',
} as const;

export interface CredentialQuery {
  redirectTo?: string;
}

export interface TenantQuery {
  cursor?: string;
}

export interface DomainsQuery {
  status?: AdminDomainStatus;
}

/**
 * The queue's default half, spelled the same way `AdminDomainQuerySchema`
 * defaults it. Named rather than repeated, because two places have to agree: the
 * filter that renders as current when the URL says nothing, and the link that
 * *drops* the parameter rather than writing what the API would have done anyway.
 */
export const DOMAIN_STATUS_DEFAULT: AdminDomainStatus = 'verified';

/** Narrows an untrusted `?status=`; anything else is the default half. */
export function parseDomainStatus(value: string | undefined): AdminDomainStatus {
  return ADMIN_DOMAIN_QUERY_STATUSES.find((status) => status === value) ?? DOMAIN_STATUS_DEFAULT;
}

/**
 * The origin an untrusted `?next=` is resolved against. `.invalid` is reserved by
 * RFC 2606 and can never be a real host, so a value that still resolves here
 * named no host of its own.
 */
const REDIRECT_ORIGIN = 'https://redirect.invalid';

/**
 * Narrows an untrusted `?next=` to a path inside this app.
 *
 * The same rule `apps/web` applies, and for the same reason: a value like
 * `//evil.example.com` is protocol-relative, and following it after a credential
 * is accepted is an open redirect that hands a freshly authenticated operator to
 * somebody else's site. The check is a real URL resolution rather than string
 * inspection, because the two disagree — the WHATWG parser strips tab, CR and LF
 * before resolving, so `/\t/evil.example.com` reads as a path to every
 * `startsWith` and resolves to another origin.
 */
export function parseRedirectPath(value: string | undefined, fallback: string): string {
  if (value === undefined || !value.startsWith('/')) {
    return fallback;
  }

  let resolved: URL;

  try {
    resolved = new URL(value, REDIRECT_ORIGIN);
  } catch {
    return fallback;
  }

  // The credential screen is not a destination: sending an operator back to the
  // door they just came through would loop them.
  if (resolved.origin !== REDIRECT_ORIGIN || resolved.pathname === '/credential') {
    return fallback;
  }

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * Builds `path?a=1&b=2` with proper encoding. Hand-concatenating a URL is how a
 * value containing `&` silently becomes two parameters.
 */
function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, value);
    }
  }

  const serialised = search.toString();

  return serialised.length > 0 ? `${path}?${serialised}` : path;
}
