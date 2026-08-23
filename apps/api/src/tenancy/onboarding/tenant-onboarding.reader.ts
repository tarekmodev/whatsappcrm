import { Inject, Injectable } from '@nestjs/common';
import {
  ONBOARDING_STEP_IDS,
  type OnboardingChecklistResponse,
  type OnboardingStep,
  type OnboardingStepId,
} from '@whatsappcrm/contracts';
import type { Prisma } from '../../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../../prisma/prisma.tokens';
import { TenantNotFoundError } from '../tenant-deactivation.errors';

/**
 * A `tenant_onboarding_steps` row, narrowed to the three columns the checklist
 * reads. `skipped_by_user_id` is deliberately absent: it is support-facing and
 * never reaches the wire (TAR-832, Security and Access).
 */
export interface OnboardingSkipRow {
  readonly stepId: string;
  readonly skippedAt: Date | null;
  readonly updatedAt: Date;
}

/** The `select` behind every read and write of a skip row, in one place. */
export const ONBOARDING_SKIP_ROW_SELECT = {
  stepId: true,
  skippedAt: true,
  updatedAt: true,
} as const satisfies Prisma.TenantOnboardingStepSelect;

/**
 * Everything the checklist is assembled from, gathered in one transaction.
 *
 * Separated from the assembly so the write path can gather once, apply its own
 * change to `skips` in memory, and render the response without a second
 * derivation — and so the assembly rules, which are where the interesting
 * decisions live, are testable as a pure function.
 */
export interface OnboardingFacts {
  /** `tenants.created_at` — the floor under the checklist's own `updatedAt`. */
  readonly tenantCreatedAt: Date;
  /**
   * Present only for a step whose underlying fact is true, mapped to the instant
   * the **fact** became true rather than the instant the checklist noticed.
   */
  readonly completedAt: ReadonlyMap<OnboardingStepId, Date>;
  readonly skips: readonly OnboardingSkipRow[];
}

/**
 * Reads `GET /api/v1/tenant/onboarding` (TAR-832, decisions 1 to 4).
 *
 * ## Completion is derived, never stored
 *
 * The database stores one thing: which steps this tenant chose to put off. A
 * step is `completed` because the tenant actually has a WhatsApp Business
 * Account, an invited agent or a branding row — so a tenant that disconnects its
 * WABA sees the step go back to `pending`, which is what the contract's
 * "cleared if the underlying fact goes away" asks for and what a materialised
 * status column drifts away from the first time a delete path forgets its hook.
 *
 * It also means every tenant provisioned before this shipped gets a correct
 * checklist on first load, with nothing to backfill.
 *
 * ## Everything on the tenant connection, in one transaction
 *
 * All five tables carry the `tenant_isolation` policy, so `TENANT_PRISMA` makes
 * a forgotten `WHERE tenant_id` a zero-row read rather than a cross-tenant leak.
 * One `$tenantTransaction` sets the GUC once instead of once per statement, and
 * — the reason that matters here — means the reads describe one instant: a WABA
 * connected between the completion read and the skip read would otherwise render
 * as a step that is both.
 *
 * The tenant id is the one `TenantContextService` resolved from the request
 * host. Neither route has a field for a caller to supply one.
 */
@Injectable()
export class TenantOnboardingReader {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  async read(tenantId: string): Promise<OnboardingChecklistResponse> {
    return await this.prisma.$tenantTransaction(async (tx) =>
      assembleChecklist(tenantId, await this.facts(tx, tenantId)),
    );
  }

  /**
   * The reads, on a caller's transaction so a write can share it.
   *
   * Sequential rather than concurrent: an interactive transaction is one
   * connection, so firing them at once buys no parallelism while making the
   * statement order — which is what a deadlock report is read against —
   * nondeterministic.
   */
  async facts(tx: Prisma.TransactionClient, tenantId: string): Promise<OnboardingFacts> {
    // `Tenant` is not narrowed inside a transaction — the extension's model
    // policies apply per statement outside one — so the id is restated by hand.
    // It is the tenant the guard resolved, never anything the request carried.
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { createdAt: true },
    });

    if (tenant === null) {
      throw new TenantNotFoundError(tenantId);
    }

    const completedAt = new Map<OnboardingStepId, Date>();

    const connectedWhatsappAt = await this.connectedWhatsappAt(tx, tenantId);
    if (connectedWhatsappAt !== null) {
      completedAt.set('connect_whatsapp', connectedWhatsappAt);
    }

    const invitedAgentsAt = await this.invitedAgentsAt(tx, tenantId);
    if (invitedAgentsAt !== null) {
      completedAt.set('invite_agents', invitedAgentsAt);
    }

    const brandedAt = await this.brandedAt(tx, tenantId);
    if (brandedAt !== null) {
      completedAt.set('set_branding', brandedAt);
    }

    const skips = await tx.tenantOnboardingStep.findMany({
      where: { tenantId },
      select: ONBOARDING_SKIP_ROW_SELECT,
    });

    return { tenantCreatedAt: tenant.createdAt, completedAt, skips };
  }

  /**
   * `connect_whatsapp` — a `whatsapp_business_accounts` row exists.
   *
   * The WABA, not a registered number. A tenant that finished Embedded Signup
   * has done what the step asks; number registration is a separate flow with its
   * own screen, and gating on it would leave the step pending for an admin who
   * has completed it (TAR-832, decision 2).
   */
  private async connectedWhatsappAt(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<Date | null> {
    const connected = await tx.whatsappBusinessAccount.aggregate({
      where: { tenantId },
      _min: { createdAt: true },
    });

    return connected._min.createdAt;
  }

  /**
   * `invite_agents` — an invite was sent, or the tenant has a second user.
   *
   * A **revoked** invite counts: the admin performed the act, and withdrawing it
   * later is a different decision from never having done it. The second-user
   * clause catches an operator-provisioned tenant whose agents were created
   * directly, and it reads "second-earliest user" rather than "not the owner"
   * because `tenants` has no owner column for the alternative to be queryable
   * against.
   */
  private async invitedAgentsAt(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<Date | null> {
    const invited = await tx.invite.aggregate({
      where: { tenantId },
      _min: { createdAt: true },
    });

    const [secondUser] = await tx.user.findMany({
      where: { tenantId },
      // `id` breaks the tie, so two users created in the same provisioning
      // transaction resolve to one stable answer rather than to whichever the
      // plan happened to return second.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: 1,
      take: 1,
      select: { createdAt: true },
    });

    return earliest([invited._min.createdAt, secondUser?.createdAt ?? null]);
  }

  /**
   * `set_branding` — a `tenant_branding` row with at least one field set.
   *
   * `created_at`, not `updated_at`: the first time the tenant touched branding,
   * rather than a `completedAt` that slides forward on every later edit and comes
   * to mean "last edited". Provisioning creates no branding row at all, so the
   * row's existence is already a real signal; the non-null clause is
   * belt-and-braces against a future default seed.
   */
  private async brandedAt(tx: Prisma.TransactionClient, tenantId: string): Promise<Date | null> {
    const branded = await tx.tenantBranding.findFirst({
      where: {
        tenantId,
        OR: [
          { productName: { not: null } },
          { primaryColor: { not: null } },
          { accentColor: { not: null } },
          { supportEmail: { not: null } },
          { logoStorageKey: { not: null } },
          { faviconStorageKey: { not: null } },
        ],
      },
      select: { createdAt: true },
    });

    return branded?.createdAt ?? null;
  }
}

/**
 * The facts as the contract's `OnboardingChecklistResponse`.
 *
 * Pure, and separate from the reads, because this is where the rules that are
 * easy to get wrong live — and none of them needs a database to be shown:
 *
 *   * **`completed` beats `skipped`** (decision 3). A step with both a skip row
 *     and a true fact renders `completed`, with `skippedAt` null. Doing the thing
 *     supersedes having put it off, and it is why `reopen` on a completed step is
 *     a 200 that changes nothing visible.
 *   * **The checklist's `completedAt` is null while any step is pending**, and
 *     otherwise the latest resolution instant — matching `onboardingProgress()`,
 *     for which a skip resolves a step just as a completion does.
 *   * **`updatedAt` has `tenants.created_at` as its floor**, so a brand-new
 *     tenant gets a stable value rather than a `now()` that churns on every read.
 *     ⚠️ It can move **backwards** when an underlying fact is deleted. It is a
 *     display value, not a concurrency token, and no caller may start using it as
 *     one.
 *
 * A row naming a step this build does not know is ignored for the steps array —
 * so a rollback that reverts the contract but not the data still serves a valid
 * response — but its `updated_at` still counts, because the tenant did touch the
 * checklist.
 */
export function assembleChecklist(
  tenantId: string,
  facts: OnboardingFacts,
): OnboardingChecklistResponse {
  const skippedAt = new Map(facts.skips.map((row) => [row.stepId, row.skippedAt]));

  const steps: OnboardingStep[] = ONBOARDING_STEP_IDS.map((id) => {
    const completed = facts.completedAt.get(id) ?? null;

    if (completed !== null) {
      return { id, status: 'completed', completedAt: completed.toISOString(), skippedAt: null };
    }

    const skipped = skippedAt.get(id) ?? null;

    if (skipped !== null) {
      return { id, status: 'skipped', completedAt: null, skippedAt: skipped.toISOString() };
    }

    return { id, status: 'pending', completedAt: null, skippedAt: null };
  });

  const resolutions = ONBOARDING_STEP_IDS.map(
    (id) => facts.completedAt.get(id) ?? skippedAt.get(id) ?? null,
  );
  const everyStepResolved = resolutions.every((instant) => instant !== null);

  return {
    tenantId,
    steps,
    completedAt: everyStepResolved ? latest(resolutions).toISOString() : null,
    updatedAt: latest([
      // The floor, and the reason `latest` can promise a date rather than null.
      facts.tenantCreatedAt,
      ...resolutions,
      ...facts.skips.map((row) => row.updatedAt),
    ]).toISOString(),
  };
}

function earliest(instants: readonly (Date | null)[]): Date | null {
  return instants.reduce<Date | null>(
    (found, instant) => (instant !== null && (found === null || instant < found) ? instant : found),
    null,
  );
}

/** The latest of the instants given. Every caller passes at least one non-null. */
function latest(instants: readonly (Date | null)[]): Date {
  const found = instants.reduce<Date | null>(
    (winner, instant) =>
      instant !== null && (winner === null || instant > winner) ? instant : winner,
    null,
  );

  if (found === null) {
    throw new TypeError('latest() needs at least one instant.');
  }

  return found;
}
