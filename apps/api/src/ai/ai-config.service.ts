import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_CONFIG_DEFAULTS,
  AI_MODEL_CATALOG,
  type AiConfigResponse,
  type AiModel,
  type AiReadiness,
  type AiReadinessBlocker,
  type UpdateAiConfigInput,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PlanFeaturesService } from '../entitlements/plan-features.service';
import type { Prisma } from '../generated/prisma/client';
import { KnowledgeDocumentStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { AiFeatureNotInPlanError } from './ai.errors';

/**
 * The per-tenant chatbot configuration, and the readiness breakdown that tells
 * the console *why* automated replies are or are not happening (0010
 * decision 4).
 *
 * ## A tenant with no row reads defaults rather than a 404
 *
 * `SlaPolicyService`'s precedent: the row is created on first write, and until
 * then `GET` answers with the column defaults and `isEnabled: false`. An admin
 * opening the settings page before anyone has touched them sees the same shape
 * they will edit, not an error.
 *
 * ## `GET` is exempt from the plan gate; `PATCH` is not
 *
 * A tenant whose plan lacks `ai_chatbot` still reads this endpoint — with
 * `isEnabled: false` and the `feature_not_in_plan` blocker — so the console can
 * render an upsell instead of a 403 page. The write is refused.
 *
 * ## Readiness is computed, never stored
 *
 * All five clauses of decision 4 are cheap: an environment variable, one
 * subscription read, one column, and two indexed existence checks. Caching them
 * would be a permission-shaped answer that keeps saying "ready" after a tenant
 * deleted their last document, which is exactly the state AC3 exists to make
 * impossible.
 */
@Injectable()
export class AiConfigService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly config: ConfigService,
    private readonly features: PlanFeaturesService,
  ) {}

  async get(): Promise<AiConfigResponse> {
    const stored = await this.prisma.aiConfig.findFirst({ select: CONFIG_PROJECTION });
    const settings = toSettings(stored);

    return {
      ...settings,
      readiness: await this.readiness(settings),
      availableModels: [...AI_MODEL_CATALOG],
      updatedAt: (stored?.updatedAt ?? new Date(0)).toISOString(),
    };
  }

  /**
   * The one write. `upsert` on the tenant's unique `tenant_id`, so the first
   * edit creates the row and every later one updates it — the lazy-create shape
   * `ticket_counters` and `sla_policies` already use, without a read-then-branch
   * that two concurrent saves could both take.
   *
   * The bounds are enforced twice on purpose: zod guards the one handler that
   * writes this row today, and the CHECK constraints TAR-402 shipped guard every
   * writer there will ever be.
   */
  async update(input: UpdateAiConfigInput): Promise<AiConfigResponse> {
    if (!(await this.features.includes('ai_chatbot'))) {
      throw new AiFeatureNotInPlanError();
    }

    const tenantId = this.tenantContext.requireTenantId();
    const data = toWriteData(input);

    await this.prisma.aiConfig.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
      select: { id: true },
    });

    return this.get();
  }

  /**
   * The five clauses of decision 4's KB-ready rule, every one of which must
   * hold, and each failure named so the console can render it.
   *
   * The order is the order they are cheapest in: an environment variable, then a
   * column already loaded, then the plan, then the two counts. `blockers` is a
   * list rather than a first-failure, because a tenant with no plan *and* no
   * documents has two things to fix and finding out about them one deploy at a
   * time is a bad settings page.
   */
  private async readiness(settings: AiSettings): Promise<AiReadiness> {
    const blockers: AiReadinessBlocker[] = [];

    if (!this.isProviderConfigured()) {
      blockers.push('provider_not_configured');
    }

    if (!(await this.features.includes('ai_chatbot'))) {
      blockers.push('feature_not_in_plan');
    }

    if (!settings.isEnabled) {
      blockers.push('disabled');
    }

    const indexedDocumentCount = await this.prisma.knowledgeDocument.count({
      where: { status: KnowledgeDocumentStatus.indexed },
    });

    // Documents and chunks are counted separately because they are separate
    // facts: a document can be marked `indexed` with zero chunks if its content
    // was whitespace. The blocker names the document count because that is what
    // an admin can act on.
    const hasChunks =
      indexedDocumentCount > 0 &&
      (await this.prisma.knowledgeChunk.findFirst({ select: { id: true } })) !== null;

    if (!hasChunks) {
      blockers.push('no_indexed_documents');
    }

    return { ready: blockers.length === 0, indexedDocumentCount, blockers };
  }

  /**
   * Whether this deployment holds a provider key at all.
   *
   * **Fail closed**, the shape `WHATSAPP_TOKEN_ENCRYPTION_KEY` and
   * `PLATFORM_ADMIN_TOKEN` already use: an environment that was never configured
   * refuses rather than half-works, and no path calls the provider. Only the
   * presence is read here — the value itself is `ClaudeClient`'s alone.
   */
  private isProviderConfigured(): boolean {
    const key = this.config.get<string>('ANTHROPIC_API_KEY');

    return key !== undefined && key.length > 0;
  }
}

const CONFIG_PROJECTION = {
  isEnabled: true,
  model: true,
  systemPrompt: true,
  handoffKeywords: true,
  minConfidence: true,
  maxBotTurns: true,
  handoffMessage: true,
  updatedAt: true,
} as const satisfies Prisma.AiConfigSelect;

type AiConfigRow = Prisma.AiConfigGetPayload<{ select: typeof CONFIG_PROJECTION }>;

/** The settings half of the response — everything that is a stored column. */
export type AiSettings = Omit<AiConfigResponse, 'readiness' | 'availableModels' | 'updatedAt'>;

/**
 * The stored row, or the defaults a tenant with no row reads.
 *
 * Exported because `BotEligibilityService` resolves the same settings for a
 * worker turn, and two readings of "what does a tenant with no row mean" is
 * exactly the drift that would make the console and the bot disagree about
 * whether the feature is on.
 */
export function toSettings(stored: AiConfigRow | null): AiSettings {
  if (stored === null) {
    return {
      isEnabled: AI_CONFIG_DEFAULTS.isEnabled,
      model: null,
      systemPrompt: null,
      handoffKeywords: [],
      minConfidence: AI_CONFIG_DEFAULTS.minConfidence,
      maxBotTurns: AI_CONFIG_DEFAULTS.maxBotTurns,
      handoffMessage: null,
    };
  }

  return {
    isEnabled: stored.isEnabled,
    // Free text in the column by design (0010 decision 10 — a CHECK would make
    // adding a model id a migration), so a value written before an id was
    // retired is normalised to "the platform default" on read rather than
    // published as a model the allowlist no longer names.
    model: isAllowedModel(stored.model) ? stored.model : null,
    systemPrompt: stored.systemPrompt,
    handoffKeywords: stored.handoffKeywords,
    // `Decimal` — the column is `numeric(3,2)` so it can be compared in SQL, and
    // the contract publishes a number. The conversion happens once, here.
    minConfidence: stored.minConfidence.toNumber(),
    maxBotTurns: stored.maxBotTurns,
    handoffMessage: stored.handoffMessage,
  };
}

function isAllowedModel(model: string | null): model is AiModel {
  return model !== null && AI_MODEL_CATALOG.some((option) => option.id === model);
}

/**
 * The columns a partial edit writes, with `undefined` meaning "leave this one
 * alone".
 *
 * Declared structurally rather than as `Prisma.AiConfigUncheckedUpdateInput`,
 * because the same object serves the `create` and the `update` halves of the
 * upsert — and the generated update type admits `{ set: … }` operation wrappers
 * that the create type does not.
 */
interface AiConfigWrite {
  isEnabled?: boolean;
  model?: string | null;
  systemPrompt?: string | null;
  handoffKeywords?: string[];
  minConfidence?: number;
  maxBotTurns?: number;
  handoffMessage?: string | null;
}

function toWriteData(input: UpdateAiConfigInput): AiConfigWrite {
  return {
    ...(input.isEnabled === undefined ? {} : { isEnabled: input.isEnabled }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    ...(input.handoffKeywords === undefined ? {} : { handoffKeywords: input.handoffKeywords }),
    ...(input.minConfidence === undefined ? {} : { minConfidence: input.minConfidence }),
    ...(input.maxBotTurns === undefined ? {} : { maxBotTurns: input.maxBotTurns }),
    ...(input.handoffMessage === undefined ? {} : { handoffMessage: input.handoffMessage }),
  };
}
