/**
 * The one place `apps/web` reads the environment. Every other module imports
 * `webEnv`, so a missing or malformed variable fails here — loudly, at module
 * load — instead of surfacing as `undefined` inside a fetch URL.
 *
 * `NEXT_PUBLIC_*` values are inlined into the browser bundle at build time, so
 * they must be referenced literally: a computed `process.env[key]` is never
 * replaced. Nothing behind this prefix may be a secret.
 */

export interface WebEnv {
  /**
   * Where `lib/api` sends requests. In the browser this is a same-origin path
   * proxied by `next.config.mjs`, because a white-label tenant on its own domain
   * would have its session cookie dropped as third-party otherwise (TAR-39,
   * Decision 3).
   */
  readonly apiBaseUrl: string;
  /**
   * The absolute API origin used by server-side rendering and server actions,
   * which have no page origin to be relative to. Server-only, so it deliberately
   * carries no `NEXT_PUBLIC_` prefix.
   */
  readonly serverApiBaseUrl: string;
  /**
   * The shared secret that proves to the API a forwarded tenant host came from
   * this tier rather than from an arbitrary caller (TAR-64). `null` when unset.
   *
   * **Server-only, and it must stay that way**: a `NEXT_PUBLIC_` prefix would
   * inline it into the browser bundle and hand it to every visitor, which is the
   * whole of the trust boundary. It is read here rather than validated, because
   * this module is also evaluated in the browser — where `process.env` carries no
   * server variables — and a throw would break the client. The server-side
   * modules that send it are the ones that insist on it.
   */
  readonly trustedProxySecret: string | null;
  /**
   * Serves every API call from the in-memory fixture layer instead of HTTP.
   * TAR-82 built the console against it before TAR-81's endpoints landed; they
   * have, so this is off in `.env.example` as well as here and survives as the
   * way to work on the console with no API running (TAR-830).
   *
   * It is not a silent mode: `components/env/MockModeBadge.tsx` marks every
   * screen while it is on, because the fixtures reuse the seed dataset's names
   * and ids and are otherwise indistinguishable from the real thing.
   */
  readonly useMockApi: boolean;
  /**
   * Exposes the stubbed role switcher. Role resolution belongs to TAR-35's
   * session; until that lands, this is how the three role-scoped views are
   * demonstrated. Refused in production — see `lib/session/session.ts`.
   */
  readonly enableRoleStub: boolean;
  /*
   * Meta's app id, the Embedded Signup configuration id and the Graph version
   * used to live here as `NEXT_PUBLIC_*` constants (TAR-169). They are gone
   * (TAR-816).
   *
   * Next.js inlines a `NEXT_PUBLIC_*` value into the browser bundle at build
   * time, and TAR-816 made the API's copy of those ids operator-editable at
   * runtime. Keeping a compiled-in copy would have meant an operator changing
   * the app id, seeing it save with a new fingerprint, and watching `FB.login`
   * keep using whatever the last deploy baked in.
   *
   * They now come from `GET /api/v1/whatsapp/embedded-signup/config`, read by
   * the server component that renders the connect wizard and handed down as a
   * prop. Nothing in `webEnv` replaces them — there is no build-time value left
   * to hold.
   */
  /**
   * Where the console tells a workspace admin to write when something needs the
   * *operator* of this deployment (TAR-515) — not the tenant's own customer
   * support address, which is `branding.supportEmail` and points the other way.
   *
   * `null` when unset, which is a real state rather than a fault: every surface
   * that reads it drops the action and keeps the sentence, because a "Contact
   * support" link that opens a blank draft is worse than none.
   *
   * Public, and correctly so: it is an address the console is asking people to
   * write to. Malformed throws for the same reason a malformed Meta id does — a
   * fat-fingered paste should fail where somebody is looking at the deploy.
   */
  readonly supportEmail: string | null;
  readonly isProduction: boolean;
}

const TRUTHY_FLAG_VALUES = ['1', 'true', 'yes', 'on'] as const;
const FALSY_FLAG_VALUES = ['', '0', 'false', 'no', 'off'] as const;

function readFlag(name: string, rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue === undefined) {
    return fallback;
  }

  const value = rawValue.trim().toLowerCase();

  if ((TRUTHY_FLAG_VALUES as readonly string[]).includes(value)) {
    return true;
  }

  if ((FALSY_FLAG_VALUES as readonly string[]).includes(value)) {
    return false;
  }

  // Name only. Echoing the value would put whatever was misconfigured in a log.
  throw new Error(`Invalid boolean value for ${name}; expected one of 1/0/true/false.`);
}

function readRequired(name: string, rawValue: string | undefined, fallback: string): string {
  const value = (rawValue ?? fallback).trim();

  if (value.length === 0) {
    throw new Error(`Invalid web environment configuration: ${name} must not be empty.`);
  }

  return value;
}

/** Absent and empty are the same thing for a secret: not configured. */
function readOptionalSecret(rawValue: string | undefined): string | null {
  const value = (rawValue ?? '').trim();

  return value.length === 0 ? null : value;
}

/**
 * Deliberately the same loose shape `branding-draft.ts` validates the tenant's
 * own address against: something, an `@`, something with a dot. Anything
 * stricter rejects addresses that are legal and deliverable.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readOptionalEmail(name: string, rawValue: string | undefined): string | null {
  const value = (rawValue ?? '').trim();

  if (value.length === 0) {
    return null;
  }

  if (!EMAIL_SHAPE.test(value)) {
    // Name only. Echoing the value would put whatever was misconfigured in a log.
    throw new Error(`Invalid web environment configuration: ${name} must be an email address.`);
  }

  return value;
}

function readWebEnv(): WebEnv {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    apiBaseUrl: readRequired(
      'NEXT_PUBLIC_API_BASE_URL',
      process.env.NEXT_PUBLIC_API_BASE_URL,
      // Same-origin default: the Next rewrite forwards it to the API host.
      '/api',
    ),
    serverApiBaseUrl: readRequired(
      'API_BASE_URL',
      process.env.API_BASE_URL,
      'http://localhost:3001/api',
    ),
    trustedProxySecret: readOptionalSecret(process.env.TRUSTED_PROXY_SECRET),
    useMockApi: readFlag('NEXT_PUBLIC_USE_MOCK_API', process.env.NEXT_PUBLIC_USE_MOCK_API, false),
    enableRoleStub: readFlag(
      'NEXT_PUBLIC_ENABLE_ROLE_STUB',
      process.env.NEXT_PUBLIC_ENABLE_ROLE_STUB,
      false,
    ),
    supportEmail: readOptionalEmail(
      'NEXT_PUBLIC_SUPPORT_EMAIL',
      process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
    ),
    isProduction,
  };
}

export const webEnv: WebEnv = readWebEnv();
