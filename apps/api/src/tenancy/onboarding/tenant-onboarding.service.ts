import { Inject, Injectable } from '@nestjs/common';
import type {
  OnboardingChecklistResponse,
  OnboardingStepId,
  OnboardingStepIntent,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import type { Prisma } from '../../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../../prisma/prisma.tokens';
import {
  assembleChecklist,
  ONBOARDING_SKIP_ROW_SELECT,
  TenantOnboardingReader,
  type OnboardingFacts,
  type OnboardingSkipRow,
} from './tenant-onboarding.reader';
import { OnboardingStepCompletedError } from './tenant-onboarding.errors';

export interface OnboardingStepUpdate {
  readonly tenantId: string;
  readonly stepId: OnboardingStepId;
  readonly intent: OnboardingStepIntent;
}

/**
 * `PATCH /api/v1/tenant/onboarding/steps/{stepId}` — the only write the checklist
 * has, and it writes only the skip (TAR-832, decision 1).
 *
 * There is deliberately no way to PATCH a step `completed`. A client that could
 * would let an admin mark a workspace set up that has no number attached to it,
 * and the checklist would then be decoration rather than a description of the
 * workspace — which is why the body carries an *intent* and not a status.
 *
 * ## One transaction, gathered once
 *
 * The facts are read, the decision is made against them, the row is written and
 * the response is assembled from the facts plus that row — all inside one
 * `$tenantTransaction`. Reading first is what makes the 409 possible at all
 * (completion is derived, so "is this already done" is a query rather than a
 * column), and doing the write in the same transaction is what stops a WABA
 * connected mid-request from producing a response describing neither state.
 *
 * The upserted row is folded into the facts in memory rather than re-derived,
 * because a skip write cannot change any completion fact — the four source
 * tables are untouched by it.
 *
 * ## No audit row
 *
 * `AuditLog` records acts with a security or billing consequence (TAR-832,
 * decision 5). Deferring a setup prompt has neither and is reversible by the
 * same click; `skipped_by_user_id` and `updated_at` carry enough to answer "who
 * put this off" if support ever asks.
 */
@Injectable()
export class TenantOnboardingService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly reader: TenantOnboardingReader,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Answers with the whole checklist, never the one step — see the controller. */
  async apply(update: OnboardingStepUpdate): Promise<OnboardingChecklistResponse> {
    return await this.prisma.$tenantTransaction(async (tx) => {
      const facts = await this.reader.facts(tx, update.tenantId);

      const skips =
        update.intent === 'skip'
          ? await this.skip(tx, update, facts)
          : await this.reopen(tx, update, facts);

      return assembleChecklist(update.tenantId, { ...facts, skips });
    });
  }

  /**
   * Put a step off.
   *
   * Refused on a completed step, and a **no-op on an already-skipped one** —
   * `skipped_at` is not rewritten, so the checklist's `updatedAt` does not churn
   * when two tabs send the same skip. The unique `(tenant_id, step_id)` is what
   * makes the upsert one row rather than a race between two.
   */
  private async skip(
    tx: Prisma.TransactionClient,
    { tenantId, stepId }: OnboardingStepUpdate,
    facts: OnboardingFacts,
  ): Promise<readonly OnboardingSkipRow[]> {
    if (facts.completedAt.has(stepId)) {
      throw new OnboardingStepCompletedError(stepId);
    }

    const existing = facts.skips.find((row) => row.stepId === stepId);

    if (existing?.skippedAt != null) {
      return facts.skips;
    }

    const skippedByUserId = this.tenantContext.userId;
    const skippedAt = new Date();

    const row = await tx.tenantOnboardingStep.upsert({
      where: { tenantId_stepId: { tenantId, stepId } },
      create: { tenantId, stepId, skippedAt, skippedByUserId },
      // Reachable for a step skipped, reopened and skipped again: the row
      // survives a reopen so that "was this ever skipped" stays answerable.
      update: { skippedAt, skippedByUserId },
      select: ONBOARDING_SKIP_ROW_SELECT,
    });

    return replaceRow(facts.skips, row);
  }

  /**
   * Put a skipped step back.
   *
   * `skipped_at` is cleared and the row is **kept**, so the checklist's own
   * `updatedAt` still moves. `skipped_by_user_id` is kept too — it is the record
   * of who deferred it, and a reopen does not make that untrue.
   *
   * A step that was never skipped is a no-op rather than an insert, and so is a
   * reopen of a `completed` step whose skip row is already clear. Where a
   * completed step *does* carry a skip row, the row is cleared and the response
   * still reads `completed`: completion is derived, so there is nothing to
   * un-derive (TAR-832, decision 3 and divergence 3).
   */
  private async reopen(
    tx: Prisma.TransactionClient,
    { tenantId, stepId }: OnboardingStepUpdate,
    facts: OnboardingFacts,
  ): Promise<readonly OnboardingSkipRow[]> {
    const existing = facts.skips.find((row) => row.stepId === stepId);

    if (existing?.skippedAt == null) {
      return facts.skips;
    }

    const row = await tx.tenantOnboardingStep.update({
      where: { tenantId_stepId: { tenantId, stepId } },
      data: { skippedAt: null },
      select: ONBOARDING_SKIP_ROW_SELECT,
    });

    return replaceRow(facts.skips, row);
  }
}

/** The gathered rows with `row` standing in for the one it shares a step with. */
function replaceRow(
  skips: readonly OnboardingSkipRow[],
  row: OnboardingSkipRow,
): readonly OnboardingSkipRow[] {
  return [...skips.filter((existing) => existing.stepId !== row.stepId), row];
}
