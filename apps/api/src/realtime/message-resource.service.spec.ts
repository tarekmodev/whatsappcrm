import { MessageResponseSchema } from '@whatsappcrm/contracts';
import type { ResponseOriginService } from '../common/response-origin.service';
import { MESSAGE_PROJECTION, type MessageRow } from '../conversations/message.mapper';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { MessageResourceService } from './message-resource.service';

/**
 * What a socket publishes for one message (TAR-69).
 *
 * Deliberately thin, because the mapping itself is not this module's: the
 * projection and `toMessageResponse` are TAR-68's, and `message.mapper.spec.ts`
 * already pins how a `received` row is published, how automation is derived and
 * how an attachment path becomes absolute. Restating those here would be a
 * second set of expectations to keep in step with a rule that has one owner.
 *
 * What is under test is the part the relay adds: that it reads with **that**
 * projection rather than one of its own, that the payload it hands to a socket
 * satisfies the contract, and that a message deleted out from under it relays
 * nothing instead of throwing into an event handler nobody awaits.
 */

const TENANT = '80111111-1111-7111-8111-111111111101';
const CONVERSATION = '80111111-1111-7111-8111-1111111111c1';
const MESSAGE = '80111111-1111-7111-8111-1111111111d1';
const USER = '80111111-1111-7111-8111-1111111111a1';
const ORIGIN = 'https://acme.app.localhost';

/** The projection's own type, plus the two columns the relay reads beside it. */
type RelayRow = MessageRow & {
  tenantId: string;
  conversation: { assignedUserId: string | null; assignedTeamId: string | null };
};

function row(overrides: Partial<RelayRow> = {}): RelayRow {
  return {
    tenantId: TENANT,
    conversation: { assignedUserId: null, assignedTeamId: null },
    id: MESSAGE,
    conversationId: CONVERSATION,
    direction: 'inbound',
    status: 'received',
    contentType: 'text',
    body: 'is my order on its way?',
    senderUserId: null,
    providerMessageId: 'wamid.abc',
    errorCode: null,
    errorMessage: null,
    sentAt: new Date('2026-08-11T09:00:00.000Z'),
    createdAt: new Date('2026-08-11T09:00:01.000Z'),
    attachments: [],
    ...overrides,
  };
}

interface Harness {
  readonly messages: MessageResourceService;
  readonly queries: unknown[];
}

function serviceFor(message: RelayRow | null): Harness {
  const queries: unknown[] = [];

  const prisma = {
    message: {
      findUnique: (args: unknown): Promise<RelayRow | null> => {
        queries.push(args);
        return Promise.resolve(message);
      },
    },
  } as unknown as TenantPrisma;

  const origin = { require: () => ORIGIN } as unknown as ResponseOriginService;

  return { messages: new MessageResourceService(prisma, origin), queries };
}

describe('reading a message back for a relay', () => {
  it('answers null for a row that is no longer there', async () => {
    // Deleted between the commit that emitted the event and this read. A race
    // with a legitimate outcome: relay nothing.
    const { messages } = serviceFor(null);

    await expect(messages.findForRelay(MESSAGE)).resolves.toBeNull();
  });

  it('reads with the same projection the messages endpoint uses', async () => {
    const { messages, queries } = serviceFor(row());

    await messages.findForRelay(MESSAGE);

    // Identity for the published fields, not a copy of the field list: a column
    // added for the REST response must reach the socket in the same release, and
    // a socket payload that quietly lagged a version behind the thread it
    // updates is the bug sharing the projection exists to prevent. The two
    // columns beside it are the audience, which the response does not carry.
    expect(queries).toEqual([
      {
        where: { id: MESSAGE },
        select: {
          ...MESSAGE_PROJECTION,
          tenantId: true,
          conversation: { select: { assignedUserId: true, assignedTeamId: true } },
        },
      },
    ]);
  });

  it('publishes a payload the contract accepts', async () => {
    const { messages } = serviceFor(row());

    const relayable = await messages.findForRelay(MESSAGE);

    expect(MessageResponseSchema.safeParse(relayable?.message).success).toBe(true);
  });

  it('reports who currently holds the conversation, from the same statement', async () => {
    // The audience has to be the one that applied to the row being published:
    // two queries would leave a window in which the thread changes hands between
    // deciding what to send and deciding who may see it.
    const { messages } = serviceFor(
      row({ conversation: { assignedUserId: USER, assignedTeamId: null } }),
    );

    const relayable = await messages.findForRelay(MESSAGE);

    expect(relayable?.audience).toEqual({
      tenantId: TENANT,
      assignedUserId: USER,
      assignedTeamId: null,
    });
  });

  it('makes an attachment absolute against the origin in scope', async () => {
    const { messages } = serviceFor(
      row({
        attachments: [
          {
            id: '80111111-1111-7111-8111-1111111111e1',
            providerMediaId: 'media-handle',
            url: '/api/v1/media/80111111-1111-7111-8111-1111111111e1/content',
            kind: 'image',
            downloadState: 'stored',
            mimeType: 'image/jpeg',
            filename: 'photo.jpg',
            sizeBytes: 2048,
          },
        ],
      }),
    );

    const relayable = await messages.findForRelay(MESSAGE);

    expect(relayable?.message.attachments[0]?.url).toBe(
      `${ORIGIN}/api/v1/media/80111111-1111-7111-8111-1111111111e1/content`,
    );
  });
});
