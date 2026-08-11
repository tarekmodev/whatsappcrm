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
   * Serves every API call from the in-memory fixture layer instead of HTTP.
   * TAR-82 ships with this on so the UI can be built and reviewed before
   * TAR-81's endpoints land; turning it off is the entire "wire to the real
   * endpoints" step.
   */
  readonly useMockApi: boolean;
  /**
   * Exposes the stubbed role switcher. Role resolution belongs to TAR-35's
   * session; until that lands, this is how the three role-scoped views are
   * demonstrated. Refused in production — see `lib/session/session.ts`.
   */
  readonly enableRoleStub: boolean;
  /**
   * The shared secret that lets the API believe the tenant host this tier
   * forwards. `HostTenantGuard` resolves the tenant from `x-forwarded-host` only
   * when the request also presents this value in `x-edge-auth`, and otherwise
   * falls back to the host the request actually arrived on — so a caller that
   * forges the header without the secret names no tenant at all (TAR-64).
   *
   * `null` when unset, which is the local-development case: with no secret the
   * API reads `Host` exactly as it does today, and nothing changes.
   *
   * ⚠️ Server-only, and deliberately **without** the `NEXT_PUBLIC_` prefix. Next
   * inlines only that prefix into the browser bundle, so this value is never
   * compiled into client code; in the browser the read below is `undefined` and
   * this is `null`. Adding the prefix would hand the secret to every visitor.
   */
  readonly trustedProxySecret: string | null;
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

/**
 * An optional secret. Absent and empty are one answer — `.env.example` documents
 * a blank value as "not set", and a secret that is the empty string is not a
 * secret. The name is never echoed with the value for the reason `readFlag`
 * gives: a thrown message ends up in a log.
 */
function readOptionalSecret(rawValue: string | undefined): string | null {
  const value = (rawValue ?? '').trim();

  return value.length === 0 ? null : value;
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
    useMockApi: readFlag('NEXT_PUBLIC_USE_MOCK_API', process.env.NEXT_PUBLIC_USE_MOCK_API, false),
    enableRoleStub: readFlag(
      'NEXT_PUBLIC_ENABLE_ROLE_STUB',
      process.env.NEXT_PUBLIC_ENABLE_ROLE_STUB,
      false,
    ),
    trustedProxySecret: readOptionalSecret(process.env.TRUSTED_PROXY_SECRET),
    isProduction,
  };
}

export const webEnv: WebEnv = readWebEnv();
