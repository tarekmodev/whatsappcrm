import { z } from 'zod';
import { ProvisionedTenantResponseSchema } from './admin';
import { PasswordSchema, SessionPrincipalSchema } from './auth';
import { IanaTimezoneSchema, LocaleSchema, TimestampSchema } from './common';
import { TenantNameSchema, TenantSlugSchema } from './tenant';

/**
 * Public self-signup: the four endpoints a visitor with no account and no tenant
 * can reach (TAR-405, ADR 0009 decision 3).
 *
 * These are the **only** routes in the product that are both outside tenancy and
 * unauthenticated — `@PublicPlatformRoute()` in the API. Everything about their
 * shape follows from that: no field carries authority, nothing identifies a
 * tenant, and the one thing that does grant authority — the verification token —
 * is generated server-side and never appears in a request the client composes.
 *
 * ## Why signup is two calls and not one
 *
 * `POST /signup` writes a pending row and sends an email. Nothing is provisioned
 * until `POST /signup/verify` presents the token. Provisioning on the first call
 * would let anything that can POST a form burn platform subdomains — `hostname`
 * is globally unique on `tenant_domains`, so a squatted slug is permanently
 * unavailable to the customer who wanted it — and would fill `tenants` with a row
 * per bot.
 *
 * That creates the problem it solves: the form has to tell somebody their slug is
 * taken *before* they go and check their inbox, which is what
 * `GET /signup/slug-available` is for and why a pending signup holds a soft
 * reservation on the name it asked for.
 */

// ---------------------------------------------------------------------------
// Policy — one object, three readers, in the shape of `AUTH_POLICY`
// ---------------------------------------------------------------------------

/**
 * The abuse limits on the four public routes, stated once so the API and the
 * form agree on them.
 *
 * The verification link's own lifetime is **not** here: it is
 * `LIFECYCLE_POLICY.signupTokenTtlMs` in `tenant.ts`, alongside every other
 * lifecycle window, because a signup that expires is the first step of the same
 * state machine and ADR 0009 fixes that object as their home. What belongs here
 * is only what is specific to the endpoints being open to the internet.
 */
export const SIGNUP_POLICY = {
  /**
   * Signups accepted from one address per hour. A person signs up once; five
   * allows a shared office NAT and a couple of mistakes.
   */
  signupsPerIpPerHour: 5,
  /**
   * Signups accepted for one email address per day. Bounds mailbox flooding
   * through the signup form the way `resetRequestsPerEmailPerHour` does for
   * password reset — the form is an unauthenticated way to make us send mail to
   * an address the sender does not control.
   */
  signupsPerEmailPerDay: 3,
  /**
   * Availability checks from one address per minute. The form checks as the user
   * types, so this is a debounce backstop rather than a security control — the
   * answer it gives away is already public in DNS.
   */
  slugChecksPerIpPerMinute: 30,
} as const;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * What the signup form posts.
 *
 * The password is taken **here**, not on the verify page, and that is a decision
 * rather than a convenience: a verify page that asks for a password is a page an
 * attacker who intercepted the link can *complete*, whereas one that only
 * confirms is not. It is hashed with argon2id at the same cost parameters as
 * `users.password_hash` before it is stored, and an unconsumed signup is deleted
 * by the expiry sweep, so an abandoned one leaves no credential behind.
 *
 * `slug` is the customer's choice and is validated by `TenantSlugSchema`,
 * because it becomes a DNS label. It is **not** derived from `tenantName`: a
 * derived slug is one the customer cannot correct, and it would collide far more
 * often than one they picked.
 */
export const SignupInputSchema = z.object({
  email: z.email(),
  password: PasswordSchema,
  /** The person signing up. Becomes the first admin's display name. */
  adminName: z.string().min(1).max(120),
  tenantName: TenantNameSchema,
  slug: TenantSlugSchema,
  timezone: IanaTimezoneSchema.optional(),
  locale: LocaleSchema.optional(),
});

/**
 * `202` from `POST /signup`. Deliberately thin: it names the address the mail
 * went to and when the link dies, and nothing else.
 *
 * In particular it does **not** say whether this was a new signup or a repeat,
 * and it does not carry an id. A response that distinguished the two would turn
 * the endpoint into an oracle for which addresses have a signup in flight.
 */
export const SignupAcceptedResponseSchema = z.object({
  email: z.email(),
  expiresAt: TimestampSchema,
});

export const SignupVerifyInputSchema = z.object({
  /** The opaque token from the emailed link's fragment. */
  token: z.string().min(1),
});

/**
 * `201` from `POST /signup/verify`, alongside the session cookie.
 *
 * The tenant exists by the time this is returned, so the caller gets everything
 * it needs to redirect into the new workspace: the tenant, the principal it is
 * now signed in as, and the hostname to go to — which is not the host the
 * request arrived on, because that was the platform host and the tenant lives on
 * its own subdomain.
 *
 * **`ProvisionedTenantResponse`, not `TenantResponse`**, and that is a
 * deliberate departure from ADR 0009's sketch. `TenantResponse` requires a
 * `branding` object, and provisioning writes no `tenant_branding` row on purpose
 * — TAR-29 owns branding, including whether that row is written eagerly. Serving
 * `TenantResponse` here would mean this endpoint inventing branding defaults,
 * which is the one thing `TenantProvisioningService` documents itself as
 * refusing to do. The shape used instead is the one the platform already
 * publishes for "a tenant that was just provisioned", which is exactly what this
 * is; the console reads branding from `GET /tenant` once it is on the tenant
 * host, where the tenant's own theme applies anyway.
 */
export const SignupCompletedResponseSchema = z.object({
  tenant: ProvisionedTenantResponseSchema,
  user: SessionPrincipalSchema,
  primaryHostname: z.string().min(1),
});

/**
 * `POST /signup/resend`. Takes the address alone: the pending signup already
 * holds everything else, and accepting any of it again would let a caller who
 * knows an address change the tenant name or slug it was signed up with.
 */
export const SignupResendInputSchema = z.object({
  email: z.email(),
});

export const SlugAvailabilityQuerySchema = z.object({
  slug: TenantSlugSchema,
});

/**
 * Whether a slug can be claimed right now — checked against provisioned tenants
 * *and* live reservations, so the form does not offer a name that a signup in
 * somebody else's inbox is about to take.
 *
 * This is an enumeration oracle for which tenants exist, and that is accepted
 * once, here: the platform subdomain is a public DNS name, so anybody who wants
 * the list can already get it from DNS. Email is not an oracle at all — identity
 * is tenant-scoped (`UNIQUE (tenant_id, email)`), so the same address signing up
 * twice is two unrelated accounts and "is this address known" has no global
 * answer to leak.
 */
export const SlugAvailabilityResponseSchema = z.object({
  slug: TenantSlugSchema,
  available: z.boolean(),
});

export type SignupInput = z.infer<typeof SignupInputSchema>;
export type SignupAcceptedResponse = z.infer<typeof SignupAcceptedResponseSchema>;
export type SignupVerifyInput = z.infer<typeof SignupVerifyInputSchema>;
export type SignupCompletedResponse = z.infer<typeof SignupCompletedResponseSchema>;
export type SignupResendInput = z.infer<typeof SignupResendInputSchema>;
export type SlugAvailabilityQuery = z.infer<typeof SlugAvailabilityQuerySchema>;
export type SlugAvailabilityResponse = z.infer<typeof SlugAvailabilityResponseSchema>;
