import type { ConversationBotState } from '@whatsappcrm/contracts';
import { canRequestHandoff } from '@/features/inbox/bot-state';
import type { ConversationHold, HoldPermissions } from '@/features/inbox/conversation-hold';

/**
 * What the open thread lets the reader do, and — when it does not let them
 * reply — the one line that says why.
 *
 * Pure, and shared by the header and the composer on purpose. Before TAR-518
 * each of them decided for itself: the header rendered a solid accent `Take over
 * from the bot` beside a solid accent `Claim`, and put a full-width saturated
 * notice under both, while the composer put a *second* full-width saturated
 * notice saying an overlapping thing about the same state. Two components
 * answering one question is how a screen ends up arguing with itself.
 *
 * ## One emphasis, one reason
 *
 * `emphasis` names the single action that unblocks replying **right now**, and
 * only that one is drawn solid. `guidance` is the same decision said in words,
 * and it belongs at the composer — where the reply the reader cannot send was
 * going to be typed — rather than above the message stream.
 */

/**
 * Which control the thread header draws as its one solid accent button.
 *
 * `claim` outranks `handoff` because the order of operations is fixed: taking a
 * thread from the chatbot does not assign it (`POST …/handoff` stops the bot and
 * writes nothing else), so an unclaimed thread still cannot be replied to
 * afterwards. Claiming is the gate; stopping the bot is the next step.
 */
export type ThreadEmphasis = 'claim' | 'handoff' | 'none';

/**
 * Why the reply box is shut, or — for `bot-answering` — why nobody has replied
 * although it is open. One value, never two on screen at once.
 */
export const COMPOSER_GUIDANCE = [
  /** The reader's role can read this conversation but not reply to it. */
  'send-not-permitted',
  /** Nobody holds it, and this reader may not take it either. */
  'claim-not-permitted',
  /** Nobody holds it. The API refuses every write into the shared pool (TAR-186). */
  'claim-first',
  /** The chatbot is answering. The box works; this explains the silence. */
  'bot-answering',
] as const;

export type ComposerGuidance = (typeof COMPOSER_GUIDANCE)[number];

export interface ThreadState {
  readonly emphasis: ThreadEmphasis;
  readonly guidance: ComposerGuidance | null;
  /** Whether the composer's controls are usable at all. */
  readonly canWrite: boolean;
}

export interface ThreadStateInput {
  readonly hold: ConversationHold;
  /** No assignee **and** no team — the state the API refuses a write on. */
  readonly isUnclaimed: boolean;
  readonly botState: ConversationBotState;
  readonly permissions: HoldPermissions;
  /** `conversation:send`. Every role above guest has it; a reader may not. */
  readonly canSend: boolean;
}

export function threadState({
  hold,
  isUnclaimed,
  botState,
  permissions,
  canSend,
}: ThreadStateInput): ThreadState {
  const isBotAnswering = canRequestHandoff(botState);
  const canTakeFromBot = isBotAnswering && permissions.canClaim;
  const canClaimThis = hold.state === 'unclaimed' && permissions.canClaim;

  const emphasis: ThreadEmphasis = canClaimThis ? 'claim' : canTakeFromBot ? 'handoff' : 'none';

  return { emphasis, guidance: guidanceFor(), canWrite: canSend && !isUnclaimed };

  function guidanceFor(): ComposerGuidance | null {
    // Permission first, then the hold, then the bot — the honest order. A role
    // that may not reply at all is not told that claiming would let them.
    if (!canSend) {
      return 'send-not-permitted';
    }

    if (isUnclaimed) {
      return permissions.canClaim ? 'claim-first' : 'claim-not-permitted';
    }

    return isBotAnswering ? 'bot-answering' : null;
  }
}
