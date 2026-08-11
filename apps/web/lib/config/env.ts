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
   * Meta's app id, as `FB.login` needs it (TAR-169). `null` when the console has
   * no Meta app configured, which is a real state rather than a fault: the
   * connection surface says so instead of offering a button that cannot work.
   *
   * **Public, and correctly so.** It is the same id Meta publishes in every
   * `sdk.js` snippet, and the credential that turns a signup code into a token is
   * `WHATSAPP_APP_SECRET`, which lives on the API and never leaves it. It is
   * `NEXT_PUBLIC_META_APP_ID` rather than the API's `META_APP_ID` because a
   * variable without the prefix is not inlined into the browser bundle at all;
   * the two must hold the same value, and `.env.example` says so where they are
   * declared.
   */
  readonly metaAppId: string | null;
  /**
   * The Facebook Login for Business configuration `FB.login` launches. Public for
   * the same reason as the app id, and `null` under the same conditions — either
   * one missing means no self-service connection.
   */
  readonly metaEmbeddedSignupConfigId: string | null;
  /**
   * The Graph version `FB.init` pins the SDK to. Pinned rather than floating for
   * the reason the API pins its own: Meta deprecates versions on a schedule, and
   * a silent bump changes behaviour underneath a caller. Keep it equal to the
   * API's `META_GRAPH_API_VERSION` — the two halves of one flow talking to two
   * versions of one API is a difference nobody would think to look for.
   */
  readonly metaGraphApiVersion: string;
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

/** Meta's ids are decimal strings — the same shape the API's schema enforces. */
const META_ID_PATTERN = /^\d{1,32}$/;

/**
 * A Meta id that may legitimately be absent, but must be an id if it is present.
 *
 * Absent is a supported configuration and produces `null`; malformed throws, on
 * the same reasoning as `readFlag` above and as the API's own boot check — a
 * fat-fingered paste should fail where somebody is looking at the deploy, not
 * thirty seconds into a flow whose credential cannot be re-requested. The value
 * is never echoed: it is not a secret, but nothing here needs to prove that by
 * printing it.
 */
function readOptionalMetaId(name: string, rawValue: string | undefined): string | null {
  const value = (rawValue ?? '').trim();

  if (value.length === 0) {
    return null;
  }

  if (!META_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid web environment configuration: ${name} must be a Meta id (digits only).`,
    );
  }

  return value;
}

const GRAPH_API_VERSION_PATTERN = /^v\d+\.\d+$/;

function readGraphApiVersion(name: string, rawValue: string | undefined, fallback: string): string {
  const value = readRequired(name, rawValue, fallback);

  if (!GRAPH_API_VERSION_PATTERN.test(value)) {
    throw new Error(`Invalid web environment configuration: ${name} must look like \`v23.0\`.`);
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
    metaAppId: readOptionalMetaId('NEXT_PUBLIC_META_APP_ID', process.env.NEXT_PUBLIC_META_APP_ID),
    metaEmbeddedSignupConfigId: readOptionalMetaId(
      'NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID',
      process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID,
    ),
    metaGraphApiVersion: readGraphApiVersion(
      'NEXT_PUBLIC_META_GRAPH_API_VERSION',
      process.env.NEXT_PUBLIC_META_GRAPH_API_VERSION,
      // The same default `META_GRAPH_API_VERSION` carries on the API side.
      'v23.0',
    ),
    isProduction,
  };
}

export const webEnv: WebEnv = readWebEnv();
