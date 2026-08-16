import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LIFECYCLE_POLICY,
  permissionsForRole,
  type MailerPort,
  type SessionPrincipal,
  type SignupInput,
  type SlugAvailabilityResponse,
} from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { generateAuthToken, hashAuthToken } from '../identity/auth-tokens';
import { MAILER } from '../identity/mailer/mailer.port';
import { PasswordService } from '../identity/password.service';
import type { SessionOrigin } from '../identity/invite.service';
import { SessionService } from '../identity/session.service';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import { uuidV7 } from '../prisma/uuid-v7';
import {
  TenantProvisioningService,
  type ProvisionedTenant,
} from '../tenancy/tenant-provisioning.service';
import {
  SignupDisabledError,
  SignupTokenInvalidError,
  SlugUnavailableError,
} from './signup.errors';
import { SignupThrottleService } from './signup-throttle.service';

/** The path the emailed link points at, on the platform host. */
const VERIFY_LINK_PATH = '/verify';

/**
 * Long enough for provisioning and the first admin on a slow database, short
 * enough that a stuck verification releases its row rather than blocking every
 * other use of the same token behind it. Matches provisioning's own budget,
 * which this transaction contains.
 */
const VERIFY_TRANSACTION_TIMEOUT_MS = 20_000;

/** What `POST /signup` and `POST /signup/resend` hand back. */
export interface RequestedSignup {
  email: string;
  expiresAt: Date;
}

/** What `POST /signup/verify` hands back: the body, plus the cookie's plaintext. */
export interface CompletedSignup {
  tenant: ProvisionedTenant;
  principal: SessionPrincipal;
  /** For `Set-Cookie` only. Never rendered into a response body. */
  sessionToken: string;
}

/**
 * Public self-signup: a visitor with no account and no tenant reaching a working
 * workspace with no operator involved (TAR-405, ADR 0009 decision 3).
 *
 * ## Nothing is provisioned until the address is verified
 *
 * `request` writes one `tenant_signups` row and sends one email. `verify`
 * consumes it and only *then* calls `TenantProvisioningService.provision()`.
 * Provisioning on the first call would let anything that can POST a form burn
 * platform subdomains — `tenant_domains.hostname` is globally unique, so a
 * squatted slug is permanently unavailable to the customer who wanted it — and
 * would fill `tenants` with a row per bot.
 *
 * The cost is that the slug has to be held between the two calls, which is what
 * `tenant_signups_slug_reserved` does: a partial unique index over
 * `(desired_slug) WHERE consumed_at IS NULL`. An index predicate must be
 * `IMMUTABLE`, so it cannot also say `AND expires_at > now()` — which is why
 * `request` deletes expired unconsumed rows for the slug inside its own
 * transaction before inserting. Same trap and same answer as
 * `invites_one_live_per_email`.
 *
 * ## Why `SystemPrisma`
 *
 * There is no tenant. `TenantPrisma` refuses every statement until one is in
 * scope, and `tenant_signups` is `system-only` — `whatsappcrm_app` is granted
 * nothing on it at all (TAR-440). This is provisioning's own call site widened by
 * the two statements either side of it, not a new unscoped surface: nothing here
 * reads a tenant's business data, and the only tenant rows written are the ones
 * this transaction just created.
 *
 * ## What an anonymous caller is told, and what they are not
 *
 * The slug is the one fact this service will confirm, and 0009 accepts that
 * explicitly: a platform subdomain is public DNS, so the answer is already
 * available to anyone who looks. **Email is never confirmed.** `request`
 * answers the same `202` whether the address is new, already has a signup in
 * flight, or already runs a tenant — otherwise the form becomes a way to ask
 * "does this person use the product". Identity is tenant-scoped
 * (`UNIQUE (tenant_id, email)`), so the same address signing up twice is two
 * unrelated accounts and there is no global answer to leak in the first place.
 */
@Injectable()
export class TenantSignupService {
  private readonly logger = new Logger(TenantSignupService.name);
  private readonly enabled: boolean;

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly prisma: SystemPrisma,
    @Inject(MAILER) private readonly mailer: MailerPort,
    private readonly provisioning: TenantProvisioningService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly throttle: SignupThrottleService,
    config: ConfigService,
  ) {
    this.enabled = config.getOrThrow<boolean>('SIGNUP_ENABLED');
  }

  /**
   * Records a signup and mails the verification link.
   *
   * The order is load-bearing, and mirrors `InviteService.accept`: the throttle
   * and the slug are checked **before** the password is hashed, so an
   * unauthenticated caller cannot spend 19 MiB and two argon2 passes of this
   * process's memory per request by posting rubbish; and the password is hashed
   * **before** the transaction opens, so a memory-hard hash never runs with a
   * database transaction held open.
   */
  async request(input: SignupInput, ipAddress: string | null): Promise<RequestedSignup> {
    this.assertEnabled();
    await this.throttle.assertMayRequest(input.email, ipAddress);

    // Cheap and out loud, so the customer fixes it while the form is still in
    // front of them. The partial unique index is still the authority — this is a
    // courtesy that loses its race harmlessly, and the insert below re-reports it.
    await this.assertSlugFree(this.prisma, input.slug);

    const passwordHash = await this.passwords.hash(input.password);
    const token = generateAuthToken();
    const expiresAt = new Date(Date.now() + LIFECYCLE_POLICY.signupTokenTtlMs);

    await this.prisma
      .$transaction(async (tx) => {
        // An abandoned signup holds its slug until something removes it, because
        // the index predicate cannot carry an expiry. This is that something,
        // scoped to the one slug being claimed rather than sweeping the table.
        await tx.tenantSignup.deleteMany({
          where: { desiredSlug: input.slug, consumedAt: null, expiresAt: { lte: new Date() } },
        });

        await this.assertSlugFree(tx, input.slug);

        await tx.tenantSignup.create({
          data: {
            id: uuidV7(),
            email: input.email,
            desiredSlug: input.slug,
            tenantName: input.tenantName,
            adminName: input.adminName,
            passwordHash,
            tokenHash: hashAuthToken(token),
            timezone: input.timezone ?? null,
            locale: input.locale ?? null,
            expiresAt,
            ipAddress,
          },
          select: { id: true },
        });
      })
      .catch((error: unknown) => {
        // The reservation index losing its race. Reported as the conflict it is
        // rather than as a fault — two people can genuinely want one name.
        if (isSlugReservationConflict(error)) {
          throw new SlugUnavailableError(input.slug);
        }

        throw error;
      });

    await this.deliver(input.email, token);

    // The address is deliberately absent: this line is written for every signup
    // attempt, including ones an abuse sweep will look at, and an unverified
    // address in the log is a personal detail nobody has confirmed yet.
    this.logger.log(`Signup requested for slug ${input.slug}; verification mailed`);

    return { email: input.email, expiresAt };
  }

  /**
   * Spends the token: provisions the tenant, makes the signup user its first
   * admin, and signs them in.
   *
   * **One transaction, and the `UPDATE` is the concurrency control.** Consumption
   * is a conditional `UPDATE … WHERE consumed_at IS NULL AND expires_at > now()
   * RETURNING`, the pattern `InviteService.accept` already sets: two simultaneous
   * uses of one link mean the second updates zero rows and is refused, so
   * `provision()` cannot run twice for one signup. A read-then-write would let
   * both through and race on the slug's unique index instead — which would
   * surface as a 500 on a link somebody clicked twice.
   */
  async verify(token: string, origin: SessionOrigin): Promise<CompletedSignup> {
    this.assertEnabled();

    const tokenHash = hashAuthToken(token);

    const completed = await this.prisma.$transaction(
      async (tx) => {
        const [signup] = await tx.$queryRaw<ConsumedSignup[]>`
          UPDATE tenant_signups
          SET consumed_at = now()
          WHERE token_hash  = ${tokenHash}
            AND consumed_at IS NULL
            AND expires_at  > now()
          RETURNING id,
                    email::text        AS email,
                    desired_slug::text AS desired_slug,
                    tenant_name,
                    admin_name,
                    password_hash,
                    timezone,
                    locale
        `;

        if (signup === undefined) {
          // Lost the race with another use of the same link, or it lapsed
          // between the click and here. Re-read to say which.
          throw new SignupTokenInvalidError(await rejectionFor(tx, tokenHash));
        }

        const { tenant } = await this.provisioning.provision(
          {
            slug: signup.desired_slug,
            name: signup.tenant_name,
            timezone: signup.timezone ?? undefined,
            locale: signup.locale ?? undefined,
            // What makes this a trial rather than an operator's tenant:
            // `trialing`, a stamped `trial_ends_at`, and the trial caps the seat
            // check reads.
            path: 'self_signup',
          },
          // In **this** transaction, not one of its own. Consuming the signup,
          // provisioning, the first admin and the session are one unit: a failure
          // at any of them must leave no tenant and a token that still works.
          tx,
        );

        const admin = await tx.user.create({
          data: {
            id: uuidV7(),
            tenantId: tenant.id,
            email: signup.email,
            name: signup.admin_name,
            // The role is not in the request and never was: the person who
            // creates a workspace owns it, and there is nobody else here to be
            // owned by. Every later member arrives through TAR-55's invite flow
            // with a role an admin chose.
            role: 'admin',
            status: 'active',
            passwordHash: signup.password_hash,
          },
          select: { id: true, email: true, name: true },
        });

        // Forensics, and the constraint that a row naming a tenant is also
        // consumed. Written after provisioning, because until it returns there is
        // no id to name.
        await tx.tenantSignup.update({
          where: { id: signup.id },
          data: { provisionedTenantId: tenant.id },
          select: { id: true },
        });

        const issued = await this.sessions.issue(tx, {
          tenantId: tenant.id,
          userId: admin.id,
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });

        const principal: SessionPrincipal = {
          userId: admin.id,
          tenantId: tenant.id,
          email: admin.email,
          displayName: admin.name,
          role: 'admin',
          // Materialised from the role through the contract's own table — never a
          // literal, so a session cannot disagree with what the matrix grants.
          permissions: [...permissionsForRole('admin')],
          teamIds: [],
          sessionId: issued.sessionId,
          expiresAt: issued.expiresAt.toISOString(),
        };

        return { tenant, principal, issued };
      },
      { timeout: VERIFY_TRANSACTION_TIMEOUT_MS },
    );

    // After the commit, for the same reason login publishes there: a cached
    // principal for a transaction that rolled back would be a live credential for
    // a session that does not exist.
    await this.sessions.publish(completed.issued, completed.principal);

    this.logger.log(
      `Signup verified: provisioned tenant ${completed.tenant.id} at ` +
        `${completed.tenant.primaryHostname}`,
    );

    return {
      tenant: completed.tenant,
      principal: completed.principal,
      sessionToken: completed.issued.token,
    };
  }

  /**
   * Re-sends the verification link for a signup that is still outstanding.
   *
   * A **new** token, and the old one stops working: the row holds one
   * `token_hash`, so overwriting it revokes the previous link. That is the right
   * way round — somebody asking for a resend usually cannot find the first mail,
   * and leaving both live would widen the window for a link that leaked in
   * transit.
   *
   * Answers the same shape whether or not there was anything to resend. An
   * address with no signup in flight gets no mail and the same `202`, because the
   * alternative is an oracle for which addresses have signed up.
   */
  async resend(email: string, ipAddress: string | null): Promise<RequestedSignup> {
    this.assertEnabled();
    await this.throttle.assertMayRequest(email, ipAddress);

    const token = generateAuthToken();
    const expiresAt = new Date(Date.now() + LIFECYCLE_POLICY.signupTokenTtlMs);

    // `updateMany` rather than a read followed by an update: the predicate and
    // the write are one statement, so a signup consumed between the two cannot
    // be handed a fresh token.
    const { count } = await this.prisma.tenantSignup.updateMany({
      where: { email, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { tokenHash: hashAuthToken(token), expiresAt },
    });

    if (count > 0) {
      await this.deliver(email, token);
    }

    return { email, expiresAt };
  }

  /**
   * Whether a slug can be claimed right now — against provisioned tenants *and*
   * live reservations, so the form does not offer a name that a signup sitting in
   * somebody else's inbox is about to take.
   */
  async slugAvailability(
    slug: string,
    ipAddress: string | null,
  ): Promise<SlugAvailabilityResponse> {
    this.assertEnabled();
    await this.throttle.assertMayCheckSlug(ipAddress);

    return { slug, available: !(await this.slugTaken(this.prisma, slug)) };
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new SignupDisabledError();
    }
  }

  private async assertSlugFree(client: SlugReader, slug: string): Promise<void> {
    if (await this.slugTaken(client, slug)) {
      throw new SlugUnavailableError(slug);
    }
  }

  /**
   * Taken by a tenant that exists, or held by a signup that has not been used and
   * has not lapsed. Both halves matter: the first alone would offer a name
   * somebody is mid-signup for, and the second alone would offer a name a tenant
   * is already serving traffic on.
   */
  private async slugTaken(client: SlugReader, slug: string): Promise<boolean> {
    const [tenant, reserved] = await Promise.all([
      client.tenant.findUnique({ where: { slug }, select: { id: true } }),
      client.tenantSignup.findFirst({
        where: { desiredSlug: slug, consumedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true },
      }),
    ]);

    return tenant !== null || reserved !== null;
  }

  /**
   * The link goes on the **platform** host, not a tenant one, and `tenantId` is
   * null to say so: at this moment there is no tenant and therefore no tenant
   * hostname. The adapter assembles the URL; this hands over the path and the
   * token, and the plaintext token exists here and in the email and nowhere else.
   */
  private async deliver(email: string, token: string): Promise<void> {
    await this.mailer.send({
      to: email,
      template: 'signup_verification',
      tenantId: null,
      data: { linkPath: VERIFY_LINK_PATH, token },
    });
  }
}

/** The columns consumption reads back, and not one more. */
interface ConsumedSignup {
  id: string;
  email: string;
  desired_slug: string;
  tenant_name: string;
  admin_name: string;
  password_hash: string;
  timezone: string | null;
  locale: string | null;
}

/**
 * Enough of a client to answer "is this slug taken" — the system client itself,
 * or a transaction on it. Structural rather than a union, so the two call sites
 * do not need a cast.
 */
type SlugReader = Pick<Prisma.TransactionClient, 'tenant' | 'tenantSignup'>;

/**
 * Which of the three it was, read after the conditional `UPDATE` matched
 * nothing. All three answer the same code to the caller; the reason travels as a
 * detail entry so the verify screen can word itself and a support engineer can
 * tell a lapsed link from a replayed one.
 */
async function rejectionFor(
  tx: Prisma.TransactionClient,
  tokenHash: string,
): Promise<'unknown' | 'expired' | 'consumed'> {
  const signup = await tx.tenantSignup.findUnique({
    where: { tokenHash },
    select: { consumedAt: true, expiresAt: true },
  });

  if (signup === null) {
    return 'unknown';
  }

  return signup.consumedAt !== null ? 'consumed' : 'expired';
}

/**
 * The partial unique index on `(desired_slug) WHERE consumed_at IS NULL`.
 *
 * Matched by constraint name rather than by the generic unique-violation code,
 * because `tenant_signups` also carries a unique index on `token_hash`, and a
 * collision there is a broken random-number generator rather than a slug
 * somebody else took — reporting it as a taken slug would hide a real fault.
 */
function isSlugReservationConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002' &&
    JSON.stringify((error as { meta?: unknown }).meta ?? {}).includes(
      'tenant_signups_slug_reserved',
    )
  );
}
