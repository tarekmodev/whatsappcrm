import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BotInboundTrigger, HandoffReason } from '@whatsappcrm/contracts';
import { PlanFeaturesService } from '../entitlements/plan-features.service';
import {
  BotTurnOutcome,
  ConversationBotState,
  KnowledgeDocumentStatus,
  MessageDirection,
} from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { toSettings, type AiSettings } from './ai-config.service';

/**
 * The gate: may the bot take this turn at all (0010 decision 4)?
 *
 * ## Two halves, and the split is what makes the rule testable
 *
 * `snapshot()` does the reads. `decideEligibility()` is a **pure function** over
 * that snapshot — no clock of its own, no database, no provider — so every
 * clause of the empty-knowledge-base rule and every silent refusal is a unit
 * test with a plain object, which is what 0010's phase table asks for: a design
 * whose central rule can only be tested against a live API is a design that will
 * not be tested.
 *
 * ## Refusing silently is the correct no-bot behaviour
 *
 * When the tenant has no provider key, no plan, the bot switched off, or no
 * indexed content, the turn is refused with **no reply, no handoff event and no
 * customer-visible change**. The conversation behaves exactly as it does today,
 * which is the one outcome that cannot regress an existing tenant — and it is
 * why a tenant with an empty knowledge base can never receive a hallucinated
 * answer: no request is ever made on their behalf.
 *
 * A refusal that *is* customer-visible — the per-conversation turn cap — is a
 * handoff instead, because the customer is mid-conversation with a bot that has
 * stopped being able to help and silence would strand them.
 */
@Injectable()
export class BotEligibilityService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly config: ConfigService,
    private readonly features: PlanFeaturesService,
  ) {}

  /**
   * Everything the gate reads, in one place.
   *
   * The counts are `findFirst` existence checks rather than `count(*)`: the
   * question is "is there any", the tables grow, and an exact number nobody
   * reads is a scan nobody needs.
   */
  async snapshot(trigger: BotInboundTrigger, now: Date): Promise<BotGateSnapshot> {
    const [config, message, conversation, indexedDocument, chunk, replies] = await Promise.all([
      this.prisma.aiConfig.findFirst({ select: CONFIG_PROJECTION }),
      this.prisma.message.findUnique({
        where: { id: trigger.messageId },
        select: { id: true, direction: true, body: true },
      }),
      this.prisma.conversation.findUnique({
        where: { id: trigger.conversationId },
        select: {
          id: true,
          botState: true,
          botEngagedAt: true,
          serviceWindowExpiresAt: true,
          // One extra column on a read already being made, rather than a sixth
          // query: an opt-out is a fact about the contact this thread belongs
          // to, and the gate must not send to them.
          contact: { select: { optedOutAt: true } },
        },
      }),
      this.prisma.knowledgeDocument.findFirst({
        where: { status: KnowledgeDocumentStatus.indexed },
        select: { id: true },
      }),
      this.prisma.knowledgeChunk.findFirst({ select: { id: true } }),
      this.prisma.botTurn.count({
        where: { conversationId: trigger.conversationId, outcome: BotTurnOutcome.replied },
      }),
    ]);

    return {
      now,
      providerConfigured: this.isProviderConfigured(),
      featureIncluded: await this.features.includes('ai_chatbot'),
      settings: toSettings(config),
      hasIndexedKnowledge: indexedDocument !== null && chunk !== null,
      message: message === null ? null : { direction: message.direction, body: message.body },
      conversation:
        conversation === null
          ? null
          : {
              botState: conversation.botState,
              botEngagedAt: conversation.botEngagedAt,
              serviceWindowExpiresAt: conversation.serviceWindowExpiresAt,
            },
      // A conversation this scope cannot read is refused as `unreadable` before
      // the opt-out clause is reached, so `false` here is never the answer to
      // "may we message them" — it is "there is nobody to ask about".
      optedOut: conversation !== null && conversation.contact.optedOutAt !== null,
      botReplyCount: replies,
    };
  }

  /** Presence only — the value itself is `ClaudeClient`'s alone. */
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
} as const;

/** Everything `decideEligibility` reads, and nothing else. */
export interface BotGateSnapshot {
  readonly now: Date;
  readonly providerConfigured: boolean;
  readonly featureIncluded: boolean;
  readonly settings: AiSettings;
  readonly hasIndexedKnowledge: boolean;
  readonly message: { readonly direction: MessageDirection; readonly body: string | null } | null;
  readonly conversation: {
    readonly botState: ConversationBotState;
    readonly botEngagedAt: Date | null;
    readonly serviceWindowExpiresAt: Date | null;
  } | null;
  /**
   * The contact asked us to stop messaging them. A regulatory obligation the
   * agent send path already enforces, and the one refusal here that is about a
   * person rather than about configuration.
   */
  readonly optedOut: boolean;
  /** Replies the bot has already made in this conversation. */
  readonly botReplyCount: number;
}

/**
 * Why a turn was refused without the customer noticing. Stored on
 * `bot_turns.error` when the turn is recorded at all, and the reason a
 * `suppressed` outcome can be explained months later.
 */
export type BotSuppressionReason =
  | 'provider_not_configured'
  | 'feature_not_in_plan'
  | 'disabled'
  | 'no_knowledge_base'
  /** The contact has opted out of messages; nothing may be sent to them. */
  | 'opted_out'
  /**
   * The bot had nothing to say, and had never said anything in this
   * conversation. Produced by the orchestrator rather than by this gate — see
   * `BotTurnService.handOff` — and the reason an opening "hi" that misses the
   * knowledge base leaves the conversation open to the question that follows.
   */
  | 'no_answer_unengaged'
  | 'not_inbound'
  | 'empty_message'
  /** The conversation is already `handed_off` or `human_active`. */
  | 'already_released'
  | 'window_closed'
  | 'unreadable';

export type BotGateDecision =
  | { readonly outcome: 'admit'; readonly question: string }
  | { readonly outcome: 'suppress'; readonly reason: BotSuppressionReason }
  | { readonly outcome: 'handoff'; readonly reason: HandoffReason };

/**
 * The gate, as a pure function.
 *
 * The order is deliberate and is the order of *cheapness and blast radius*: the
 * platform-wide clauses first, then the tenant's own configuration, then the
 * knowledge base, then this conversation, then this message. A tenant with no
 * plan is refused for that reason rather than for whichever of the five other
 * things also happened to be true, which is what makes the `bot_turns.error`
 * column worth querying.
 */
export function decideEligibility(snapshot: BotGateSnapshot): BotGateDecision {
  if (!snapshot.providerConfigured) {
    return { outcome: 'suppress', reason: 'provider_not_configured' };
  }

  if (!snapshot.featureIncluded) {
    return { outcome: 'suppress', reason: 'feature_not_in_plan' };
  }

  if (!snapshot.settings.isEnabled) {
    return { outcome: 'suppress', reason: 'disabled' };
  }

  // TAR-28 AC3, and the clause the whole design rests on: no knowledge base
  // means no reply, decided here rather than hoped for from the model.
  if (!snapshot.hasIndexedKnowledge) {
    return { outcome: 'suppress', reason: 'no_knowledge_base' };
  }

  if (snapshot.message === null || snapshot.conversation === null) {
    // The rows the trigger names are not readable in this scope — deleted, or a
    // payload that never resolves. Suppressed rather than retried: the caller
    // has already opened the tenant scope, so this is a correct state that no
    // number of attempts changes.
    return { outcome: 'suppress', reason: 'unreadable' };
  }

  // Honouring an opt-out is a regulatory obligation, not a preference, and the
  // agent send path has always refused one (`ContactOptedOutError`). This is the
  // same rule for the path that has no human in it.
  //
  // **Before the turn cap on purpose.** `max_turns` is a *handoff*, and a
  // handoff may send the tenant's `handoffMessage` — which is an outbound
  // WhatsApp message like any other. Placing the opt-out check after it would
  // leave one path on which a contact who asked us to stop still hears from us.
  //
  // Suppressed rather than handed off: the customer's message is already in the
  // inbox and already has a ticket, so a human can still answer it deliberately.
  // What must not happen is this process sending anything, and silence is
  // exactly that.
  if (snapshot.optedOut) {
    return { outcome: 'suppress', reason: 'opted_out' };
  }

  if (snapshot.message.direction !== MessageDirection.inbound) {
    return { outcome: 'suppress', reason: 'not_inbound' };
  }

  const question = snapshot.message.body?.trim() ?? '';

  if (question === '') {
    // A sticker, a location pin, an image with no caption. There is nothing to
    // retrieve against, and answering "I don't understand" to every photo a
    // customer sends is worse than saying nothing.
    return { outcome: 'suppress', reason: 'empty_message' };
  }

  // Both are terminal for the bot, and neither has a transition back to
  // `bot_active` in 0010 decision 5's state machine.
  //
  // `human_active` is the important one: a bot that resumes after an agent has
  // spoken talks over a colleague in front of the customer, and no confidence
  // score prevents that. `handed_off` is the same rule one step earlier — the
  // conversation has already been given to a person who has not picked it up
  // yet, and answering into it would be the bot taking back a thread it
  // released. It is also what makes the tenant's handoff message "once per
  // conversation" without a second counter to keep.
  //
  // The reset to `off` when the conversation is resolved or closed is what stops
  // either meaning "one handoff disables the bot for this contact for ever".
  if (
    snapshot.conversation.botState === ConversationBotState.human_active ||
    snapshot.conversation.botState === ConversationBotState.handed_off
  ) {
    return { outcome: 'suppress', reason: 'already_released' };
  }

  if (!isWindowOpen(snapshot.conversation.serviceWindowExpiresAt, snapshot.now)) {
    // Nearly unreachable — an inbound message is what opens the 24-hour window —
    // and kept because the alternative is a bot reply that Meta refuses after
    // the turn has already been recorded as sent.
    return { outcome: 'suppress', reason: 'window_closed' };
  }

  // The loop-breaker for a bot and a customer talking past each other. A handoff
  // rather than a suppression: the customer is mid-conversation and silence
  // would strand them.
  if (snapshot.botReplyCount >= snapshot.settings.maxBotTurns) {
    return { outcome: 'handoff', reason: 'max_turns' };
  }

  return { outcome: 'admit', question };
}

/**
 * Meta's 24-hour customer service window.
 *
 * Restated here rather than imported from `ConversationsModule`: this module is
 * L4 and that one is L3, so importing it would be legal — but the check is two
 * lines and a null case, and an `AiModule` that depends on the inbox module in
 * order to read one column is a module edge nobody would expect. If a third
 * reader appears, the shape moves to `@whatsappcrm/contracts`.
 */
function isWindowOpen(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() > now.getTime();
}
