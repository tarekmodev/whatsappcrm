import type { ResponseOriginService } from '../common/response-origin.service';
import type { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { ConversationQueryService } from '../conversations/conversation-query.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { QueueService } from '../queue/queue.service';
import { HandoffService } from './handoff.service';

/**
 * `requestFromAgent` — the endpoint behind the console's **Take from bot**
 * button, and the third place in this module that has to answer "how many times
 * has the bot replied".
 *
 * It writes a `handoff_events` row an agent then reads as "Replies before
 * handing over". The number and the `bot_engaged_at` beside it are rendered on
 * the same card as the transcript they are supposed to describe, so a count over
 * a different span of time is not an inaccuracy — it is a card that contradicts
 * itself in front of the person deciding how much the bot already tried.
 */

const TENANT = '70444444-4444-7444-8444-444444444401';
const CONVERSATION = '70444444-4444-7444-8444-4444444444c1';
const TICKET = '70444444-4444-7444-8444-4444444444c9';
const INBOUND = '70444444-4444-7444-8444-4444444444e0';
const ENGAGED_AT = new Date('2026-08-20T09:00:00.000Z');

function conversationRow() {
  const now = new Date('2026-08-20T10:00:00.000Z');

  return {
    id: CONVERSATION,
    contact: {
      id: '70444444-4444-7444-8444-4444444444d1',
      phoneE164: '+10000040211',
      displayName: null,
      email: null,
      tags: [],
      customFields: {},
      lastSeenAt: null,
      optedOutAt: null,
      createdAt: now,
      updatedAt: now,
    },
    whatsappAccountId: '70444444-4444-7444-8444-444444444402',
    status: 'open',
    assignedUserId: null,
    assignedTeamId: null,
    tickets: [{ id: TICKET }],
    unreadCount: 0,
    serviceWindowExpiresAt: null,
    botState: 'bot_active',
    messages: [],
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

describe('HandoffService.requestFromAgent', () => {
  let service: HandoffService;
  let handoffEvents: Record<string, unknown>[];
  let countArgs: { where: Record<string, unknown> }[];
  let botState: string;
  let botEngagedAt: Date | null;
  /** Replied turns created at or after the engagement stamp. */
  let repliesSinceEngagement: number;

  beforeEach(() => {
    handoffEvents = [];
    countArgs = [];
    botState = 'bot_active';
    botEngagedAt = ENGAGED_AT;
    repliesSinceEngagement = 1;

    const transactionClient = {
      handoffEvent: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          handoffEvents.push(data);

          return Promise.resolve({ id: 'event' });
        }),
      },
      conversation: { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) },
    };

    const prisma = {
      $tenantTransaction: (work: (tx: unknown) => Promise<unknown>) => work(transactionClient),
      conversation: {
        findUniqueOrThrow: jest.fn(() => Promise.resolve({ botState, botEngagedAt })),
      },
      message: { findFirst: jest.fn(() => Promise.resolve({ id: INBOUND })) },
      ticket: { findFirst: jest.fn(() => Promise.resolve({ id: TICKET })) },
      botTurn: {
        count: jest.fn((args: { where: Record<string, unknown> }) => {
          countArgs.push(args);

          return Promise.resolve(repliesSinceEngagement);
        }),
      },
    } as unknown as TenantPrisma;

    service = new HandoffService(
      prisma,
      { requireTenantId: () => TENANT } as unknown as TenantContextService,
      {
        // Enough of a row for `toConversationResponse`, which this endpoint
        // returns. What it says is not under test here; that it can be built is.
        require: () => Promise.resolve(conversationRow()),
      } as unknown as ConversationQueryService,
      {} as unknown as ResponseOriginService,
      { enqueue: jest.fn(() => Promise.resolve('added')) } as unknown as QueueService,
    );
  });

  /** What the handoff event says about the bot's replies. */
  function recordedReplyCount(): unknown {
    return handoffEvents.at(0)?.botReplyCount;
  }

  it('counts only the replies inside the engagement it is ending', async () => {
    // The trigger: a contact the bot answered three times in June, whose thread
    // an agent resolved — clearing `bot_engaged_at` and keeping the three
    // `bot_turns` rows, because they are the tuning record. Today the bot
    // answered twice more. A lifetime count writes 5 beside a transcript that
    // holds 2.
    repliesSinceEngagement = 1;

    await service.requestFromAgent(CONVERSATION);

    expect(recordedReplyCount()).toBe(2);
    expect(countArgs).toEqual([
      {
        where: {
          conversationId: CONVERSATION,
          outcome: 'replied',
          createdAt: { gte: ENGAGED_AT },
        },
      },
    ]);
  });

  it('writes a count and a window that describe the same span of time', async () => {
    // The database cannot catch a mismatch here:
    // `handoff_events_engagement_matches_replies` only asks the count to be zero
    // when there is no stamp, which any wrong-but-positive number satisfies.
    await service.requestFromAgent(CONVERSATION);

    expect(handoffEvents.at(0)).toMatchObject({
      botEngagedAt: ENGAGED_AT,
      botReplyCount: 2,
      reason: 'agent_requested',
      triggerMessageId: INBOUND,
    });
  });

  it('reports no replies for a conversation the bot has not spoken in', async () => {
    // Reachable: the bot claims a conversation as `bot_active` on its first
    // turn, and an agent can press the button while the model is still thinking.
    botEngagedAt = null;

    await service.requestFromAgent(CONVERSATION);

    expect(recordedReplyCount()).toBe(0);
    // Nothing to count, so nothing is asked.
    expect(countArgs).toEqual([]);
  });

  it('writes nothing for a conversation the bot never had', async () => {
    // A double-clicked button is a no-op, not a second event.
    botState = 'handed_off';

    await service.requestFromAgent(CONVERSATION);

    expect(handoffEvents).toEqual([]);
  });
});
