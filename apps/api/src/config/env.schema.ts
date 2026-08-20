import { z } from 'zod';
import { parsePlatformAdminCredentials } from '../common/security/platform-admin-credentials';

/**
 * Every environment variable the API reads, in one place. The process refuses to
 * boot if this schema fails — a missing secret is a startup crash, never a
 * `undefined` that surfaces three hours later in production.
 *
 * `.env.example` at the repository root is the human-readable mirror of this
 * schema and must be updated in the same commit whenever a key is added here.
 */
/** Pino's level names, in the order pino orders them. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/**
 * Which provisioned environment this process is. Distinct from `NODE_ENV`, which
 * only says how the code was built: all three deployed environments run
 * `NODE_ENV=production`, and telling them apart is what makes a log line, a
 * metric and a Sentry issue attributable.
 */
export const DEPLOY_ENVS = ['local', 'development', 'staging', 'production'] as const;

/**
 * Where the Socket.IO server sits on a developer's machine — the API's own
 * origin, since the gateway runs in this process.
 *
 * Exported because `RealtimeTicketService` needs the same fallback:
 * `ConfigService.get` can answer from `process.env` as well as from the
 * validated object, so a reader cannot assume the schema default was applied.
 * One constant, rather than the same literal in two files drifting apart.
 */
export const DEFAULT_REALTIME_URL = 'http://localhost:3001';

/**
 * A configured Meta id — the app id, the Embedded Signup configuration id.
 *
 * Digits, held as a string: Meta's ids exceed `Number.MAX_SAFE_INTEGER`, so a
 * value parsed as a number would silently change. The ceiling is a sanity check
 * on a configured value rather than a claim about Meta's format.
 *
 * Deliberately local rather than imported from `packages/contracts`, which
 * validates the same ids when they arrive in a request body: those are two
 * different trust boundaries, and making the boot path depend on the wire
 * contract for one regex couples them for no gain.
 */
const MetaIdSchema = z.string().regex(/^\d{1,32}$/, 'Must be a Meta id (digits only)');

const envShape = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  /** Origin of the Next.js app, used for the CORS allow-list. */
  WEB_ORIGIN: z.string().min(1).default('http://localhost:3000'),

  /** Injected by the deployment target; surfaced on the health endpoint. */
  APP_VERSION: z.string().min(1).default('0.0.0'),

  /** Names the provisioned environment. Stamped on every log line and Sentry event. */
  DEPLOY_ENV: z.enum(DEPLOY_ENVS).default('local'),

  // ---------------------------------------------------------------------------
  // Database. Two URLs, because the isolation model is two database roles
  // (TAR-48, `prisma/sql/app-roles.sql`) and which role a client connects as is
  // the whole guarantee. Required: the API has a data layer now, and a process
  // that boots without one only fails later and less clearly.
  //
  // Neither may point at the migration owner. On a managed instance the owner
  // is usually a superuser, and a superuser skips row-level security entirely —
  // every tenant would see every row, with nothing in the logs to say so.
  // ---------------------------------------------------------------------------

  /** `TenantPrisma`, as `whatsappcrm_app`: subject to RLS, holds no BYPASSRLS. */
  APP_DATABASE_URL: z.string().min(1),
  /** `SystemPrisma`, as `whatsappcrm_system`: reads and writes across tenants. */
  SYSTEM_DATABASE_URL: z.string().min(1),

  // ---------------------------------------------------------------------------
  // Tenancy (TAR-19)
  // ---------------------------------------------------------------------------

  /**
   * The zone every tenant's platform subdomain is issued under, so a tenant with
   * slug `acme` is reachable at `acme.<PLATFORM_DOMAIN>`. Custom domains (TAR-29)
   * are added alongside it, never instead of it: the platform subdomain is the
   * host that is guaranteed to work while a customer's DNS is still propagating.
   */
  PLATFORM_DOMAIN: z.string().min(1).default('app.localhost'),

  /**
   * The hostname a tenant points its own domain at — the CNAME target on the
   * routing record `POST /api/v1/tenant/domains` hands back (TAR-419).
   *
   * A bare hostname, no scheme and no trailing dot: it goes into a DNS record
   * rather than a URL, which is what separates it from `WEB_ORIGIN`. In a
   * deployed environment it is the *public* edge host of the web service, and
   * the deployment target's own service-discovery value is the wrong one — on
   * Render, `fromService.property: host` is the private-network name, which no
   * customer's resolver can see.
   *
   * Optional, and absent means this environment cannot tell a tenant where to
   * point its DNS. The custom-domain routes must **refuse the claim** in that
   * state rather than emit a routing record with a blank target: a tenant that
   * publishes a CNAME to nothing waits for a verification that cannot arrive,
   * and the misconfiguration surfaces days later as a support ticket instead of
   * immediately as a 5xx. No default — every plausible guess (`PLATFORM_DOMAIN`,
   * the API's own host) is a hostname that resolves somewhere wrong, which is
   * worse than a hostname that is missing.
   *
   * Not a secret: it is published to every tenant that adds a domain.
   * Attaching the domain at the edge is an operator step —
   * docs/runbooks/custom-domains.md.
   */
  PLATFORM_EDGE_HOSTNAME: z.string().min(1).optional(),

  /**
   * What a tenant that has set no product name of its own is called (TAR-29).
   *
   * Configuration rather than a constant, because a white-label deployment of
   * this platform is not necessarily called what the repository is called, and
   * the value is rendered in the browser title and on the login screen of every
   * tenant that has not customised it. Optional: absent falls back to
   * `BRANDING_DEFAULTS.productName` in `@whatsappcrm/contracts`, which is the
   * one place the fallback is written so the API and the web app cannot show a
   * different name for the same tenant.
   *
   * Not a secret — it is published to every unauthenticated caller by
   * `GET /api/v1/tenant/public`.
   */
  PLATFORM_PRODUCT_NAME: z.string().min(1).max(60).optional(),

  /**
   * How long an unverified custom-domain claim survives before the sweeper
   * deletes it and releases the hostname (TAR-29).
   *
   * A claim reserves a **globally unique** hostname, so without an expiry one
   * tenant typing a competitor's domain holds it forever. Seven days is long
   * enough for a customer to get a DNS change through a change-control process
   * and short enough that a squat is a nuisance rather than a hostage situation.
   *
   * Reclaim latency is the sweep interval on top of this, which is documented
   * behaviour: a tenant told `conflict` on a hostname whose claim has just
   * lapsed succeeds on retry within one sweep.
   */
  DOMAIN_VERIFICATION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  /**
   * How often pending claims are re-checked and lapsed ones released.
   *
   * This is what makes verification *arrive* without the tenant sitting on a
   * settings screen: DNS propagation is minutes to hours, and a flow that only
   * verifies on demand is one where the customer's experience is "it did not
   * work, try again later". Per-claim backoff lives in the sweeper, so a
   * shorter interval here does not mean more queries per domain.
   */
  DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15 * 60_000),

  /**
   * Upper bound on one DNS lookup during ownership verification.
   *
   * Every outbound call has one, and this one sits on a request path a tenant is
   * watching. Deliberately short: the resolver is asked for a record at a name
   * the tenant nominated, so a slow answer is far more likely to be a nameserver
   * that is not going to answer than one that needs another second. A timeout is
   * recorded as `lookup_timeout` on the row and retried by the sweeper.
   */
  DOMAIN_VERIFICATION_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(3_000),

  /**
   * The scheme put in front of a tenant's hostname when an email has to carry an
   * absolute link back into the product — the invite and password-reset links
   * (TAR-53, link shapes).
   *
   * Configuration rather than a branch on the environment name: `https` is the
   * only correct answer anywhere the platform is deployed, and `http` is needed
   * only on a local machine where nothing is serving TLS. A service that decided
   * this by reading `DEPLOY_ENV` would be one `if` away from mailing a plaintext
   * link into production.
   */
  APP_LINK_SCHEME: z.enum(['http', 'https']).default('https'),

  /**
   * Whether the four public self-signup routes are served at all (TAR-405,
   * TAR-36's stated assumption that a deployment can turn self-serve off and fall
   * back to the operator-provisioned path from TAR-19).
   *
   * On by default, because self-signup is the product. When off, every signup
   * route answers `404` rather than `403`: a disabled feature that advertises
   * itself by refusing differently is a feature somebody probes, and a reseller
   * who has turned self-serve off does not want the endpoint confirming it exists.
   *
   * `z.stringbool` rather than `z.coerce.boolean`, which reads the string
   * `"false"` as `true` — the classic way an off switch ships stuck on.
   */
  SIGNUP_ENABLED: z.stringbool().default(true),

  /**
   * Named bearer credentials for `/api/v1/admin/*`, as comma-separated
   * `label:secret` entries (TAR-166):
   *
   *     ops-alice:<secret>,ci-provisioner:<secret>
   *
   * One entry per operator or automation. The label is not a secret — it is
   * written to `audit_logs.actor_label` so the trail can say *which* operator
   * connected a WhatsApp Business Account or deactivated a tenant — and the
   * secret half never leaves the process. Revoking one operator is deleting one
   * entry rather than rotating everybody.
   *
   * **The unlabelled form is refused, with no transitional dual-accept.** A bare
   * secret still authenticates a request but writes an audit row that cannot
   * name who acted, and that is the gap this change exists to close. Every
   * environment holding this variable is updated in the same release — see the
   * deploy note in `.env.example`.
   *
   * Optional here and **absent means the whole admin surface refuses every
   * request** — an environment that has not been given a token cannot provision
   * tenants, which is the safe default for a route that creates them. Malformed
   * is different: it fails the boot, because it is a mistake rather than a
   * decision.
   *
   * 32 characters is the floor for a secret compared against by an
   * unauthenticated caller. Generate each with `openssl rand -base64 48`; they
   * belong in the platform's secret store.
   *
   * Still a placeholder in one respect: every entry is authorised for every
   * tenant, because the operator is not a tenant user and sits outside the
   * session and RBAC model TAR-35 and TAR-22 build.
   */
  PLATFORM_ADMIN_TOKEN: z
    .string()
    .min(1)
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined) {
        return;
      }

      try {
        parsePlatformAdminCredentials(value);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          // The parser's messages never quote a secret, which is what makes
          // them safe to put in a boot failure a deploy log will keep.
          message: error instanceof Error ? error.message : 'is malformed',
        });
      }
    }),

  // ---------------------------------------------------------------------------
  // The edge trust boundary (TAR-148)
  //
  // Render routes by `Host` at its edge and tenant domains are attached to the
  // *web* service, so inside the API `request.hostname` is always the API's own
  // host — on the browser path through the Next.js rewrite as much as on the SSR
  // path. `HostTenantGuard` therefore reads the host the web tier forwards in
  // `x-edge-host`, but only from a caller that can prove it *is* the web tier.
  // ---------------------------------------------------------------------------

  /**
   * The secret the web tier presents as `x-edge-auth`, which is what makes its
   * `x-edge-host` worth reading. Absent means the header pair is ignored
   * entirely and the tenant is resolved from `Host`, exactly as before — the
   * fallback is never the value the caller supplied.
   *
   * Both headers are private names. The standard `x-forwarded-host` is not read
   * at all: the hop between the two services is a public one, and a payload
   * every proxy on it is entitled to rewrite is not a payload.
   *
   * Optional here so a local machine and the test suite keep working with no
   * secret at all, but the refinement at the bottom of this file refuses to
   * **boot** under `NODE_ENV=production` without it, matching the
   * `SESSION_COOKIE_SECURE` / `AUTH_STUB_ENABLED` precedent: a production API
   * that cannot resolve a tenant serves nothing, and an instance that never
   * becomes ready is one the platform does not roll into.
   *
   * 32 characters is the floor for something compared against by an
   * unauthenticated caller. Generate with `openssl rand -hex 32`, one per
   * environment, and give the web service the same value — server-side only,
   * never behind `NEXT_PUBLIC_`, which would inline it into the browser bundle.
   */
  TRUSTED_PROXY_SECRET: z.string().min(32).optional(),

  /**
   * The previous `TRUSTED_PROXY_SECRET`, accepted alongside the current one.
   *
   * Rotation would otherwise need both services to swap values in the same
   * instant, and a mismatch is a total outage on every tenant route. With this
   * it is three ordinary deploys: move the old value here and the new one into
   * `TRUSTED_PROXY_SECRET`, so the API accepts both; move the web tier onto the
   * new value; then drop this key.
   */
  TRUSTED_PROXY_SECRET_PREVIOUS: z.string().min(32).optional(),

  // ---------------------------------------------------------------------------
  // Access control (TAR-22)
  // ---------------------------------------------------------------------------

  /**
   * ⚠️ **INTERIM — REMOVE WHEN TAR-35 LANDS.**
   *
   * Binds `StubPrincipalSource` instead of the session-backed one, so the
   * permission matrix and the role-scoped queries can be built and tested before
   * there is a session to read a role from. It stubs *the source of the
   * principal*, never the guard: `PermissionGuard` and the visibility predicate
   * run identically either way.
   *
   * Two kill switches, mirroring the console's (`NEXT_PUBLIC_ENABLE_ROLE_STUB`):
   * off by default, and the refinement at the bottom of this file refuses to
   * *boot* when it is on under `NODE_ENV=production`. Failing at startup rather
   * than per request is what stops a misconfigured deploy serving a single
   * stubbed call.
   *
   * Left as the literal string rather than transformed to a boolean:
   * `ConfigService.get` can answer from `process.env` as well as from the
   * validated object, so a reader comparing against `true` would sometimes see
   * the string `'true'` and quietly treat the switch as off — a kill switch
   * that fails open in one of its two read paths. `AUTH_STUB_ON` is the one
   * spelling every reader compares against.
   */
  AUTH_STUB_ENABLED: z.enum(['true', 'false']).default('false'),

  // ---------------------------------------------------------------------------
  // Sessions (TAR-35 / TAR-56)
  // ---------------------------------------------------------------------------

  /**
   * Whether the session cookie carries `Secure` and the `__Host-` prefix.
   *
   * `true` everywhere real. `false` exists for one reason: Safari does not treat
   * plain-HTTP `localhost` as a secure context, so a `__Host-` cookie cannot be
   * set there at all and local development would be unable to log in. The
   * refinement below refuses to boot with it off under `NODE_ENV=production` —
   * a session cookie without `Secure` is one a network attacker reads.
   *
   * The name is a function of this flag (`sessionCookieName` in the contract),
   * so the API, the Next.js proxy and the tests cannot disagree about which of
   * the two spellings is in play.
   */
  SESSION_COOKIE_SECURE: z.stringbool().default(true),

  /**
   * Whether `request.ip` is the address of the **client**, which is what
   * decides whether the per-address login failure window (TAR-59) is enforced.
   *
   * Off by default, and that default is the safe one rather than the timid one.
   * Express `trust proxy` is deliberately not set — `HostTenantGuard` depends on
   * `Host` being unforgeable — so behind a load balancer `request.ip` is the
   * *proxy's* address and every agent in a tenant shares one window. Twenty
   * failed sign-ins would then lock the whole tenant out of logging in for
   * fifteen minutes, which is a denial of service dressed as a control.
   *
   * Turn it on where the API terminates connections from clients directly.
   * TAR-148 has since decided the forwarded-header question for the *host*:
   * behind `TRUSTED_PROXY_SECRET` the web tier is authenticated, so the client
   * address can be read from `x-forwarded-for` under the same gate and this flag
   * can default on. That belongs to TAR-59 and is deliberately not done here —
   * still without `trust proxy`, for the reason above. Nothing else changes: the
   * durable per-account lockout is unconditional and is the layer that protects
   * an individual account.
   */
  LOGIN_IP_THROTTLE_ENABLED: z.stringbool().default(false),

  // ---------------------------------------------------------------------------
  // Realtime (TAR-20 / TAR-69)
  // ---------------------------------------------------------------------------

  /**
   * Absolute origin of the Socket.IO server, published verbatim on
   * `RealtimeTicketResponse.realtimeUrl`.
   *
   * Configured rather than derived, and it is the one URL in the product the
   * browser is told to open **directly** instead of through the Next.js rewrite:
   * ADR 0002 decision 3 sends every HTTP call through the proxy so the session
   * cookie stays first-party, and takes the WebSocket off that path because it
   * cannot be proxied as reliably. Nothing else can supply this — a tenant's own
   * white-label host is not where the realtime tier lives, and the request
   * `Host` is the API's own name behind Render's edge.
   *
   * It reaches a browser, so it is not a secret and carries no credential. The
   * local default matches `PORT`, on the `WEB_ORIGIN` precedent: a developer who
   * copies `.env.example` verbatim gets a working one.
   */
  REALTIME_URL: z.url().default(DEFAULT_REALTIME_URL),

  // ---------------------------------------------------------------------------
  // WhatsApp webhook ingestion (TAR-20)
  //
  // One Meta app serves every tenant, so both secrets below are platform-level
  // rather than per-tenant: tenant routing is `phone_number_id` →
  // `whatsapp_accounts` (TAR-39, webhook ingestion), not a per-tenant secret.
  // ---------------------------------------------------------------------------

  /**
   * The Meta app secret. `X-Hub-Signature-256` is HMAC-SHA256 of the **raw**
   * request body under this key, and that signature is the only thing standing
   * between an unauthenticated public route and the inbox.
   *
   * **Read on a second path since TAR-161**: it is also the `client_secret` on
   * the Embedded Signup code exchange. One variable rather than two, because it
   * is the same secret of the same Meta app, and a duplicate is a rotation that
   * silently half-applies — the webhook keeps verifying while every signup
   * fails, or the reverse. Absent, both paths fail closed independently.
   *
   * Optional here and **absent means every inbound webhook is rejected**, on the
   * same reasoning as `PLATFORM_ADMIN_TOKEN`: an environment that was never
   * given the secret must fail closed rather than accept unsigned payloads.
   * Requiring it outright would instead stop the API booting everywhere the
   * channel is not configured, which trades a local refusal for a global outage.
   */
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),

  /**
   * The token echoed back to Meta during the `GET` verification handshake.
   * Absent means the handshake always answers 403 — the same fail-closed
   * default, and it is only ever read once, when the webhook URL is registered.
   */
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),

  /**
   * How long a stored event may sit in `received` or `processing` before the
   * sweeper treats it as stuck and re-enqueues it. Well under the five minutes
   * TAR-39 says should page someone, so recovery is attempted before an alert
   * fires.
   */
  WEBHOOK_STUCK_AFTER_MS: z.coerce.number().int().min(1_000).default(60_000),

  /** How often the sweeper runs. */
  WEBHOOK_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),

  /**
   * Processing attempts a stored event gets before it is parked `failed`. It is
   * parked, never dropped: a failed row stays queryable and re-runnable.
   */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  // ---------------------------------------------------------------------------
  // SLA timers (TAR-26)
  // ---------------------------------------------------------------------------

  /**
   * How often the breach sweep runs, and therefore the **upper bound on
   * detection latency** (0006, decision 1). Thirty seconds against a 60-minute
   * first-response window is 0.8% of it.
   *
   * It is a floor on cost as well: the query runs whether or not anything is
   * due. 0006 records the interval as an assumption rather than a measurement,
   * and names shortening it as one of the levers once a full batch comes back on
   * consecutive sweeps — which `SlaSweepService` logs so the signal exists.
   *
   * Configurable mainly so a test environment can make a breach observable in
   * seconds rather than waiting out a real interval.
   */
  SLA_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),

  // ---------------------------------------------------------------------------
  // Workflow automation (TAR-27)
  // ---------------------------------------------------------------------------

  /**
   * How often the elapsed-trigger sweep runs, and therefore the upper bound on
   * detection latency for `ticket_unresolved_for` (0009, decision 3). Sixty
   * seconds against a four-hour threshold is 0.4% of it.
   *
   * Longer than `SLA_SWEEP_INTERVAL_MS` on purpose. An SLA breach is a
   * contractual deadline measured in minutes; an escalation threshold is a
   * supervisor's own rule with a five-minute floor, so the same precision would
   * buy nothing and cost one probe per active tenant twice as often.
   *
   * 0009 risk 7 records this as an assumption rather than a measurement.
   * `WorkflowElapsedSweep` logs batch size and elapsed time on every run that
   * finds work, so the evidence to change it exists from the first commit.
   */
  WORKFLOW_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),

  // ---------------------------------------------------------------------------
  // WhatsApp Cloud API (TAR-20)
  // ---------------------------------------------------------------------------

  /**
   * AES-256-GCM key for the per-WABA access token, base64-encoded — 32 bytes,
   * which `openssl rand -base64 32` produces.
   *
   * Optional here and **absent means every WhatsApp connection and every send is
   * refused**, on the same reasoning as `PLATFORM_ADMIN_TOKEN`: an environment
   * that was never given a key must not fall back to storing the most sensitive
   * credential in the schema in clear text. Requiring it outright would instead
   * stop the API booting in every environment that does not use the channel,
   * which trades a loud, local failure for a global one.
   *
   * It is a key, not a password, so it is checked for length rather than
   * strength — 32 bytes from a CSPRNG, held in the platform's secret store.
   * Rotating it needs the tokens re-encrypted; see `access-token.cipher.ts`,
   * whose payloads carry a version tag for exactly that reason.
   */
  WHATSAPP_TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine(isBase64EncodedKey, 'Must be 32 bytes of base64 (openssl rand -base64 32)')
    .optional(),

  /**
   * Meta's Graph API origin. Configurable so tests and a local stub can point
   * the client somewhere else; there is no other reason to change it.
   */
  META_GRAPH_API_BASE_URL: z.url().default('https://graph.facebook.com'),

  /**
   * The Graph API version every request is issued against. Pinned rather than
   * floating: Meta deprecates versions on a published schedule, and a silent
   * bump is how a response shape changes underneath a parser.
   */
  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'Must look like `v23.0`')
    .default('v23.0'),

  /**
   * Per-request timeout for a Graph API call. Every outbound call has one — an
   * unbounded wait on Meta becomes an unbounded wait on a queue worker.
   */
  META_GRAPH_API_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

  // ---------------------------------------------------------------------------
  // Embedded Signup (TAR-161, 0002 amendment 2)
  //
  // How a tenant connects its own WABA from the console: Meta hands the browser
  // a code, the code is exchanged server-to-server for the business token, and
  // nothing here is a secret — the app secret that completes the exchange is
  // `WHATSAPP_APP_SECRET` above, reused rather than duplicated.
  //
  // Both are optional and **fail closed at the route**, the shape
  // `WHATSAPP_TOKEN_ENCRYPTION_KEY` already uses: an environment that has not
  // been configured for signup answers `whatsapp_signup_failed` /
  // `insufficient_permissions` on that one endpoint and is otherwise untouched.
  // Requiring them would instead stop the API booting everywhere the channel is
  // not configured, trading a local refusal for a global outage.
  //
  // Both are Meta ids and therefore digits: checked here so a fat-fingered paste
  // is a failed boot rather than a Graph call that fails per request, in the one
  // flow whose credential expires in 30 seconds and cannot be retried.
  // ---------------------------------------------------------------------------

  /** `client_id` on the code exchange, and what the console launches `FB.login` with. */
  META_APP_ID: MetaIdSchema.optional(),

  /**
   * The Facebook Login for Business configuration the console launches. Read by
   * the console rather than by the API — declared here anyway, so this schema
   * stays the one place a complete environment is described, on the precedent
   * `DATABASE_URL` already sets.
   */
  META_EMBEDDED_SIGNUP_CONFIG_ID: MetaIdSchema.optional(),

  // ---------------------------------------------------------------------------
  // Media pipeline (TAR-20e)
  // ---------------------------------------------------------------------------

  /**
   * Where re-hosted media is written.
   *
   * A filesystem root, because this platform has no object store yet: ADR 0001
   * chose Render and took no decision on blob storage, and TAR-41 is the story
   * that provisions infrastructure. `MediaStorage` is a port with exactly one
   * adapter today for that reason — the S3-compatible adapter is a second
   * implementation of the same three methods, not a rewrite of the pipeline.
   *
   * Until then this path **must be a durable volume**: a container's writable
   * layer is not, and media written there is gone on the next deploy while the
   * rows pointing at it survive. Relative paths resolve against the process
   * working directory, which differs between `pnpm dev`, `pnpm test` and a
   * container — give a deployed environment an absolute one.
   */
  MEDIA_STORAGE_ROOT: z.string().min(1).default('.media-storage'),

  /**
   * Per-request timeout for fetching the bytes of one media object from Meta's
   * CDN.
   *
   * Separate from `META_GRAPH_API_TIMEOUT_MS`, and much larger, because it
   * bounds a different thing: that one bounds a small JSON round trip, this one
   * bounds a transfer that may legitimately be 100 MB. Sharing the value would
   * mean either a 10-second cap that fails every large document or a
   * 60-second cap on every template list.
   */
  MEDIA_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),

  /**
   * Attempts an inbound download gets before the attachment is parked `failed`.
   *
   * Meta's media URL is valid for five minutes, so the retry budget is small on
   * purpose: past that window no further attempt can succeed, and spending
   * twenty of them only delays the moment the inbox stops showing a spinner.
   */
  MEDIA_DOWNLOAD_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  // ---------------------------------------------------------------------------
  // Ticketing (TAR-21)
  // ---------------------------------------------------------------------------

  /**
   * Attempts a `ticket.ensure-for-message` job gets before it lands in the
   * failed set.
   *
   * Larger than the media budget, because what it retries is the opposite kind
   * of failure. A media download races a five-minute URL, so a late attempt is
   * wasted; the dominant reason a ticket trigger fails is that the job overtook
   * the transaction that wrote its message, which the very next attempt fixes.
   * The failed set is monitored (0003) precisely because a message that never
   * became a ticket is a support request nobody sees, so the budget is set to
   * exhaust only on a real fault rather than on a commit-visibility blip.
   */
  TICKET_LINK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  // ---------------------------------------------------------------------------
  // Infrastructure. Optional at scaffold time so the API boots with no backing
  // services. TAR-41 provisions these and promotes them to required.
  // ---------------------------------------------------------------------------

  /**
   * The migration owner's connection, read by the Prisma CLI through
   * `prisma.config.mjs` — never by the running API. Declared here so the
   * schema stays the one place a complete environment is described.
   */
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),

  // ---------------------------------------------------------------------------
  // Observability (TAR-41)
  // ---------------------------------------------------------------------------

  /** `silent` exists for the test suite; every deployed environment sets a real level. */
  LOG_LEVEL: z.enum([...LOG_LEVELS, 'silent']).default('info'),

  /**
   * Human-readable log output. Never enable this in a deployed environment — the
   * log collector parses JSON.
   */
  LOG_PRETTY: z.stringbool().default(false),

  /** A request at or above this duration is logged at `warn` and flagged `slow`. */
  SLOW_REQUEST_THRESHOLD_MS: z.coerce.number().int().positive().default(1_000),

  /** Upper bound on a single readiness probe, so a hung dependency cannot hang the probe. */
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),

  /** Absent in local development: the SDK then no-ops rather than buffering events. */
  SENTRY_DSN: z.url().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
});

/**
 * The one cross-key rule, and the reason this file exports a refined schema
 * rather than the plain object: a fabricated principal must never be reachable
 * in production, whatever `AUTH_STUB_ENABLED` says.
 *
 * Enforced here rather than in the guard so the process **refuses to boot**. A
 * per-request check would let a misconfigured deploy come up healthy, pass its
 * readiness probe and take traffic, and only refuse the requests that happened
 * to reach the stubbed path. `validateEnv` runs while `ConfigModule` is
 * initialising, which is before a single route is mapped.
 */
/** The only value that turns the interim role stub on. */
export const AUTH_STUB_ON = 'true';

export const envSchema = envShape.superRefine((env, ctx) => {
  // TAR-41: every deployed environment runs NODE_ENV=production, and a service
  // that boots pointing at no queue looks healthy right up until the first job.
  if (env.NODE_ENV === 'production' && !env.REDIS_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['REDIS_URL'],
      message: 'is required when NODE_ENV=production',
    });
  }

  // A session cookie without `Secure` travels in clear text over any plain-HTTP
  // hop, and the `__Host-` prefix it also drops is what stops a sibling tenant
  // subdomain shadowing it. Neither is optional outside a developer's machine.
  if (!env.SESSION_COOKIE_SECURE && env.NODE_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['SESSION_COOKIE_SECURE'],
      message:
        'must not be disabled when NODE_ENV=production — it drops both the Secure flag and the ' +
        '__Host- cookie prefix. It exists only so Safari can set a cookie on plain-HTTP localhost.',
    });
  }

  // Without it `HostTenantGuard` reads `Host`, which behind Render's edge is the
  // API's own host and matches no tenant domain — so every tenant route answers
  // a uniform `tenant_not_found` that reads exactly like an unknown domain.
  // Refusing to boot turns that silent, total outage into a failed deploy the
  // previous instance keeps serving through.
  if (env.NODE_ENV === 'production' && !env.TRUSTED_PROXY_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['TRUSTED_PROXY_SECRET'],
      message:
        'is required when NODE_ENV=production — without it the API cannot trust the host the ' +
        'web tier forwards, and no tenant resolves in a deployed environment.',
    });
  }

  if (env.AUTH_STUB_ENABLED === AUTH_STUB_ON && env.NODE_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_STUB_ENABLED'],
      message:
        'must not be enabled when NODE_ENV=production — the interim role stub fabricates a ' +
        'principal and is for local development and tests only. Wire TAR-35 sessions instead.',
    });
  }
});

export type Env = z.infer<typeof envSchema>;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type DeployEnv = (typeof DEPLOY_ENVS)[number];

/** The key length AES-256 requires, in bytes. */
export const WHATSAPP_TOKEN_KEY_BYTES = 32;

/**
 * True when `value` is base64 that decodes to exactly `WHATSAPP_TOKEN_KEY_BYTES`.
 *
 * The round-trip is what makes this a real check: `Buffer.from(…, 'base64')`
 * ignores every character outside the alphabet rather than failing, so a
 * truncated or hand-edited value would otherwise decode to something shorter and
 * be caught only by `createCipheriv` at first use — in production, on the first
 * connection attempt.
 */
function isBase64EncodedKey(value: string): boolean {
  const decoded = Buffer.from(value, 'base64');

  return decoded.length === WHATSAPP_TOKEN_KEY_BYTES && decoded.toString('base64') === value;
}
