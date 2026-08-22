import { describe, expect, it } from 'vitest';
import type { MessageResponse } from '@whatsappcrm/contracts';
import { RUN_GAP_MS, groupMessagesIntoRuns, senderOf } from './message-runs';

const AGENT_ID = '0192f003-0000-7000-8000-000000000301';
const OTHER_AGENT_ID = '0192f003-0000-7000-8000-000000000302';

function message(id: string, sentAt: string, overrides: Partial<MessageResponse> = {}) {
  return {
    id,
    conversationId: '0192f004-0000-7000-8000-000000000401',
    direction: 'inbound',
    type: 'text',
    status: 'delivered',
    body: 'Hello',
    attachments: [],
    sentByUserId: null,
    sentByAutomation: false,
    origin: 'contact',
    providerMessageId: null,
    failureReason: null,
    sentAt,
    createdAt: sentAt,
    ...overrides,
  } satisfies MessageResponse;
}

const outbound = {
  direction: 'outbound',
  origin: 'agent',
  sentByUserId: AGENT_ID,
} as const satisfies Partial<MessageResponse>;

describe('groupMessagesIntoRuns', () => {
  it('collapses three consecutive messages from one sender into one run', () => {
    const runs = groupMessagesIntoRuns([
      message('a', '2026-08-11T09:00:00.000Z'),
      message('b', '2026-08-11T09:00:20.000Z'),
      message('c', '2026-08-11T09:00:40.000Z'),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.messages.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    // The label hangs on the first message of the run, not the last.
    expect(runs[0]?.isoTimestamp).toBe('2026-08-11T09:00:00.000Z');
    expect(runs[0]?.key).toBe('a');
  });

  it('starts a new run when the sender changes', () => {
    const runs = groupMessagesIntoRuns([
      message('a', '2026-08-11T09:00:00.000Z'),
      message('b', '2026-08-11T09:00:10.000Z', outbound),
      message('c', '2026-08-11T09:00:20.000Z'),
    ]);

    expect(runs.map((run) => run.sender.kind)).toEqual(['contact', 'agent', 'contact']);
  });

  it('keeps two agents apart even though both are outbound', () => {
    const runs = groupMessagesIntoRuns([
      message('a', '2026-08-11T09:00:00.000Z', outbound),
      message('b', '2026-08-11T09:00:10.000Z', { ...outbound, sentByUserId: OTHER_AGENT_ID }),
    ]);

    expect(runs).toHaveLength(2);
  });

  it('breaks a run on a gap, so the run’s one timestamp stays honest', () => {
    const start = Date.parse('2026-08-11T09:00:00.000Z');
    const runs = groupMessagesIntoRuns([
      message('a', new Date(start).toISOString()),
      message('b', new Date(start + RUN_GAP_MS + 1000).toISOString()),
    ]);

    expect(runs).toHaveLength(2);
  });

  it('keeps a message exactly on the gap boundary in the run', () => {
    const start = Date.parse('2026-08-11T09:00:00.000Z');
    const runs = groupMessagesIntoRuns([
      message('a', new Date(start).toISOString()),
      message('b', new Date(start + RUN_GAP_MS).toISOString()),
    ]);

    expect(runs).toHaveLength(1);
  });

  it('measures the gap from the run’s last message, not its first', () => {
    const start = Date.parse('2026-08-11T09:00:00.000Z');
    const runs = groupMessagesIntoRuns([
      message('a', new Date(start).toISOString()),
      message('b', new Date(start + RUN_GAP_MS).toISOString()),
      message('c', new Date(start + RUN_GAP_MS * 2).toISOString()),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.messages).toHaveLength(3);
  });

  it('returns nothing for an empty thread', () => {
    expect(groupMessagesIntoRuns([])).toEqual([]);
  });
});

describe('senderOf', () => {
  it('names the chatbot before it names automation', () => {
    // Both flags are set on a bot reply. `origin` is the narrower answer and the
    // only one that can distinguish a chatbot from a workflow.
    expect(
      senderOf(
        message('a', '2026-08-11T09:00:00.000Z', {
          direction: 'outbound',
          origin: 'bot',
          sentByAutomation: true,
        }),
      ),
    ).toEqual({ kind: 'bot' });
  });

  it('calls a system send automation rather than a teammate', () => {
    expect(
      senderOf(
        message('a', '2026-08-11T09:00:00.000Z', {
          direction: 'outbound',
          origin: 'system',
          sentByAutomation: true,
        }),
      ),
    ).toEqual({ kind: 'automation' });
  });

  it('calls an unresolvable human a teammate, never automation', () => {
    expect(
      senderOf(
        message('a', '2026-08-11T09:00:00.000Z', {
          direction: 'outbound',
          origin: 'agent',
          sentByUserId: null,
        }),
      ),
    ).toEqual({ kind: 'teammate' });
  });
});
