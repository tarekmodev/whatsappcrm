import type { AiConfigResponse, AiReadinessBlocker } from '@whatsappcrm/contracts';
import type { Content } from '@/lib/content';
import { CHATBOT_SECTION_IDS } from './constants';
import { formatConfidence } from './presentation';
import type { SourceHealth } from './chatbot.data';

/**
 * The chatbot's decision path, derived from the configuration it already
 * publishes (TAR-813).
 *
 * The bot runs one linear sequence per inbound message — eligible? → retrieve
 * from the sources → confident enough? → answer, or hand over — and ADR 0010
 * fixes both the gates and their order. This turns that into four described
 * stages so the console can draw the path rather than list seven fields and
 * leave the reader to infer it.
 *
 * **A picture of the architecture, not a graph anybody builds.** The shape is
 * exactly four stages, always, and nothing here adds, removes or reorders one.
 * There are no nodes to drag, no edges to connect and no branch to author: the
 * bot answers from a knowledge base through an LLM, and this file's whole job is
 * to say where in that fixed path it currently stops.
 *
 * Pure, and takes `content` rather than reaching for it, so every sentence the
 * rail shows can be asserted without rendering anything.
 */

export const PIPELINE_STAGE_IDS = ['sources', 'eligibility', 'confidence', 'handoff'] as const;
export type PipelineStageId = (typeof PIPELINE_STAGE_IDS)[number];

/**
 * What a stage's marker says, in the one word the stylesheet needs.
 *
 * `inert` covers two different silences on purpose: a pipeline stopped before it
 * began (no provider, no plan) and a stage downstream of one that is blocking.
 * Both mean "nothing reaches here", and drawing the second as `live` would put
 * three green dots after the amber one that says the flow already stopped.
 */
export const PIPELINE_MARKER_TONES = ['live', 'blocking', 'failed', 'inert'] as const;
export type PipelineMarkerTone = (typeof PIPELINE_MARKER_TONES)[number];

export interface PipelineStage {
  readonly id: PipelineStageId;
  /** The card this stage links to; `SectionCard`'s `id`. */
  readonly targetId: string;
  readonly label: string;
  /** What the stage is currently set to, in words. Never a bare figure. */
  readonly value: string;
  readonly tone: PipelineMarkerTone;
  /** The whole link's accessible name — label, value, and whether it stops here. */
  readonly linkName: string;
  /** Whether the connector *after* this stage carries the flow onward. */
  readonly isFlowing: boolean;
}

export interface ChatbotPipeline {
  readonly stages: readonly PipelineStage[];
  readonly isReady: boolean;
  /**
   * The blockers that are not stages: the provider is a property of the
   * deployment and the plan is a property of the subscription, and colouring a
   * stage for either would send an admin to fix the wrong thing.
   */
  readonly conditions: readonly AiReadinessBlocker[];
}

/** The two blockers that are conditions on the deployment rather than steps in the path. */
const CONDITION_BLOCKERS = ['provider_not_configured', 'feature_not_in_plan'] as const;

export function chatbotPipeline(
  content: Content,
  config: AiConfigResponse,
  health: SourceHealth,
): ChatbotPipeline {
  const { blockers } = config.readiness;
  const conditions = CONDITION_BLOCKERS.filter((blocker) => blockers.includes(blocker));
  // Nothing reaches any stage, so no stage is where it stopped. The notice above
  // the rail carries the reason and every marker goes quiet.
  const isInert = conditions.length > 0;

  const values = stageValues(content, config, health);
  const blocking: Record<PipelineStageId, boolean> = {
    sources: blockers.includes('no_indexed_documents'),
    eligibility: blockers.includes('disabled'),
    // Neither is a gate that can be closed: a threshold always has a value, and
    // the handoff message is what happens *after* the path has run out.
    confidence: false,
    handoff: false,
  };

  let hasStopped = isInert;

  const stages = PIPELINE_STAGE_IDS.map((id): PipelineStage => {
    const isBlocking = !isInert && blocking[id];
    const isReached = !hasStopped;
    const label = content.chatbot.stages[id];
    const value = values[id];

    hasStopped = hasStopped || isBlocking;

    return {
      id,
      targetId: CHATBOT_SECTION_IDS[id],
      label,
      value,
      tone: markerTone({
        isBlocking,
        isReached,
        hasFailedSources: id === 'sources' && health.failedCount > 0,
      }),
      linkName: isBlocking
        ? content.chatbot.stageLinkNameBlocking(label, value)
        : content.chatbot.stageLinkName(label, value),
      isFlowing: !hasStopped,
    };
  });

  return { stages, isReady: config.readiness.ready, conditions };
}

function markerTone({
  isBlocking,
  isReached,
  hasFailedSources,
}: {
  isBlocking: boolean;
  isReached: boolean;
  hasFailedSources: boolean;
}): PipelineMarkerTone {
  if (isBlocking) {
    return 'blocking';
  }

  if (!isReached) {
    return 'inert';
  }

  // A failed source with others still indexed does not stop the bot — it answers
  // from the rest — so this is a warning on a live stage rather than a block.
  return hasFailedSources ? 'failed' : 'live';
}

function stageValues(
  content: Content,
  config: AiConfigResponse,
  health: SourceHealth,
): Record<PipelineStageId, string> {
  const ready =
    health.readyCount === 0
      ? content.chatbot.stageSourcesNone
      : content.chatbot.stageSourcesReady(health.readyCount);

  return {
    // The failure is said in words as well as drawn in red: a reader who cannot
    // separate the two dot colours still learns that something needs them.
    sources:
      health.failedCount === 0
        ? ready
        : `${ready} · ${content.chatbot.stageSourcesFailed(health.failedCount)}`,
    eligibility: config.isEnabled
      ? content.chatbot.stageEligibilityOn(config.maxBotTurns)
      : content.chatbot.stageEligibilityOff,
    confidence: content.chatbot.stageConfidence(
      formatConfidence(content.locale, config.minConfidence),
    ),
    handoff:
      config.handoffMessage === null || config.handoffMessage.trim() === ''
        ? content.chatbot.stageHandoffSilent
        : content.chatbot.stageHandoffMessage,
  };
}
