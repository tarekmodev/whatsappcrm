import { BotTurnOutcome } from '../generated/prisma/enums';
import type { TenantPrisma } from '../prisma/prisma.tokens';

/**
 * Replies the bot has made **in the engagement that is running now**, not in the
 * conversation's whole history.
 *
 * ## Why this is a module rather than a method
 *
 * Three places need this number and they answer to different owners: the gate
 * decides whether a turn may start, the orchestrator decides whether a refusal
 * is terminal, and `HandoffService` writes it onto a `handoff_events` row an
 * agent reads. Written out three times it was wrong in two of them, in the same
 * way, three days apart. One function is the fix that stays fixed.
 *
 * ## The distinction, which is the whole point
 *
 * `bot_engaged_at` is cleared when a conversation is resolved or closed (0010
 * decision 5, `ConversationCommandService.setStatus`), but `bot_turns` rows are
 * never deleted — they are the tuning record. Counted over the conversation's
 * lifetime, the stamp and the count describe different spans of time, and a
 * returning customer arrives with a null stamp beside a non-zero count. Every
 * consumer that has read the pair has got that case wrong:
 *
 *   * `hasNeverEngaged` read it as "the bot has spoken", so an opening greeting
 *     that missed the knowledge base became a terminal handoff — and the real
 *     question, one message later, was refused as `already_released`.
 *   * `max_turns` compared a lifetime total against a per-conversation cap, so a
 *     contact who crossed it across separate, long-resolved engagements was
 *     handed off on every first message for ever.
 *   * `requestFromAgent` wrote the lifetime number onto a `handoff_events` row
 *     beside a `bot_engaged_at` from *this* engagement, so the console's handoff
 *     card said "5 replies" above a transcript containing two. The check
 *     constraint cannot catch that: `bot_reply_count = 0 OR bot_engaged_at IS
 *     NOT NULL` is satisfied by any wrong-but-positive count.
 *
 * Scoped, the stamp and the count describe the same span and agree by
 * construction.
 *
 * ## The `+ 1`, which is not a fudge
 *
 * A turn is claimed on `bot_turns` **before** the model is called, and
 * `bot_engaged_at` is stamped afterwards, in the transaction that sends the
 * reply. So the reply that *starts* an engagement always has a `created_at`
 * earlier than the stamp it wrote, and `gte` cannot see it. Every later reply is
 * created after the stamp and is counted normally. A non-null stamp therefore
 * means exactly one such reply, counted here rather than matched by the
 * predicate — without it the turn cap fires one reply late.
 *
 * Strictly this rests on two clocks: `created_at` is the database's `now()` and
 * the stamp is the API process's. The gap it needs to survive is a model call —
 * hundreds of milliseconds at least — against NTP skew between a server and its
 * database, so the ordering holds by a wide margin rather than by luck. It is
 * not a certainty, and if it ever failed the effect is bounded and benign: one
 * extra reply before the cap, on one conversation.
 */
export async function countRepliesThisEngagement(
  prisma: TenantPrisma,
  conversationId: string,
  botEngagedAt: Date | null,
): Promise<number> {
  if (botEngagedAt === null) {
    // No engagement is running, so there is nothing to count and no query worth
    // making — the common case, on every conversation the bot has not yet
    // answered in.
    return 0;
  }

  const since = await prisma.botTurn.count({
    where: {
      conversationId,
      outcome: BotTurnOutcome.replied,
      createdAt: { gte: botEngagedAt },
    },
  });

  return since + 1;
}
