import { MessageResponseSchema } from '@whatsappcrm/contracts';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import {
  MessageResourceService,
  toMessageResponse,
  type RelayableAttachmentRow,
  type RelayableMessageRow,
} from './message-resource.service';
import type { TenantOriginService } from './tenant-origin.service';

/**
 * What a socket publishes for one message (TAR-69).
 *
 * Every case here asserts against `MessageResponseSchema` rather than against a
 * literal alone, because the payload rule is the contract's — "whole resources,
 * not deltas" — and a field this mapper forgot would otherwise pass a hand-
 * written expectation that forgot it too.
 */

const CONVERSATION = '80111111-1111-7111-8111-1111111111c1';
const MESSAGE = '80111111-1111-7111-8111-1111111111d1';
const ATTACHMENT = '80111111-1111-7111-8111-1111111111e1';
const USER = '80111111-1111-7111-8111-1111111111a1';
const ORIGIN = 'https://acme.app.localhost';

function row(overrides: Partial<RelayableMessageRow> = {}): RelayableMessageRow {
  return {
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

function attachment(overrides: Partial<RelayableAttachmentRow> = {}): RelayableAttachmentRow {
  return {
    id: ATTACHMENT,
    providerMediaId: 'media-handle',
    url: null,
    kind: 'image',
    downloadState: 'pending',
    mimeType: 'image/jpeg',
    filename: null,
    sizeBytes: null,
    ...overrides,
  };
}

describe('mapping a message onto the wire', () => {
  it('publishes a payload the contract accepts', () => {
    const published = toMessageResponse(row(), null);

    expect(MessageResponseSchema.safeParse(published).success).toBe(true);
  });

  it('publishes an inbound message as delivered', () => {
    // The database has `received` for the terminal state of an inbound message
    // and the contract does not: "inbound messages are born delivered, there is
    // nothing to track". This is that sentence, spelled.
    expect(toMessageResponse(row(), null).status).toBe('delivered');
  });

  it.each(['queued', 'sent', 'delivered', 'read', 'failed'] as const)(
    'publishes the outbound status %s unchanged',
    (status) => {
      expect(toMessageResponse(row({ direction: 'outbound', status }), null).status).toBe(status);
    },
  );

  it('publishes timestamps as instants, not as dates', () => {
    const published = toMessageResponse(row(), null);

    expect(published.sentAt).toBe('2026-08-11T09:00:00.000Z');
    expect(published.createdAt).toBe('2026-08-11T09:00:01.000Z');
  });

  it('flattens Meta’s error code and title into one reason', () => {
    const published = toMessageResponse(
      row({ status: 'failed', errorCode: '131047', errorMessage: 'Re-engagement message' }),
      null,
    );

    expect(published.failureReason).toBe('131047: Re-engagement message');
  });

  it.each([
    ['neither', null, null, null],
    ['only a code', '131047', null, '131047'],
    ['only a title', null, 'Re-engagement message', 'Re-engagement message'],
  ])('carries %s', (_case, code, message, expected) => {
    expect(
      toMessageResponse(row({ errorCode: code, errorMessage: message }), null).failureReason,
    ).toBe(expected);
  });

  it('leaves an attachment’s url null while its bytes are still owed', () => {
    const published = toMessageResponse(row({ attachments: [attachment()] }), ORIGIN);

    // The download runs off the ingest path, so `message.created` reaches the
    // inbox with a spinner rather than a picture. Publishing a URL here would be
    // a link to bytes nobody has fetched.
    expect(published.attachments[0]?.url).toBeNull();
    expect(published.attachments[0]?.downloadState).toBe('pending');
  });

  it('makes a stored attachment absolute against the tenant’s own origin', () => {
    const published = toMessageResponse(
      row({
        attachments: [
          attachment({
            url: `/api/v1/media/${ATTACHMENT}/content`,
            downloadState: 'stored',
            sizeBytes: 2048,
            filename: 'invoice.pdf',
          }),
        ],
      }),
      ORIGIN,
    );

    expect(published.attachments[0]?.url).toBe(`${ORIGIN}/api/v1/media/${ATTACHMENT}/content`);
    expect(MessageResponseSchema.safeParse(published).success).toBe(true);
  });

  it('publishes no url at all when the tenant has no verified host', () => {
    // `z.url()` cannot hold a path, and inventing a host is how a relay ends up
    // naming somebody else's. Null is the honest answer.
    const published = toMessageResponse(
      row({
        attachments: [attachment({ url: '/api/v1/media/x/content', downloadState: 'stored' })],
      }),
      null,
    );

    expect(published.attachments[0]?.url).toBeNull();
  });

  it('names the agent who sent an outbound reply', () => {
    const published = toMessageResponse(
      row({ direction: 'outbound', status: 'sent', senderUserId: USER }),
      null,
    );

    expect(published.sentByUserId).toBe(USER);
    expect(published.sentByAutomation).toBe(false);
  });
});

describe('reading a message back for a relay', () => {
  function serviceFor(message: RelayableMessageRow | null): {
    messages: MessageResourceService;
    originLookups: number;
    queries: unknown[];
  } {
    const queries: unknown[] = [];
    let originLookups = 0;

    const prisma = {
      message: {
        findUnique: (args: unknown): Promise<RelayableMessageRow | null> => {
          queries.push(args);
          return Promise.resolve(message);
        },
      },
    } as unknown as TenantPrisma;

    const origins = {
      originForTenantInScope: (): Promise<string | null> => {
        originLookups += 1;
        return Promise.resolve(ORIGIN);
      },
    } as unknown as TenantOriginService;

    return {
      messages: new MessageResourceService(prisma, origins),
      get originLookups() {
        return originLookups;
      },
      queries,
    };
  }

  it('answers null for a row that is no longer there', async () => {
    // Deleted between the commit that emitted the event and this read. A race
    // with a legitimate outcome: relay nothing.
    const { messages } = serviceFor(null);

    await expect(messages.findForRelay(MESSAGE)).resolves.toBeNull();
  });

  it('selects only the columns the response publishes', async () => {
    const { messages, queries } = serviceFor(row());

    await messages.findForRelay(MESSAGE);

    const [query] = queries as [{ select: Record<string, unknown> }];

    // `messages` also carries `delivered_at`, `read_at`, `failed_at` and
    // `updated_at`. None of them is in the contract, and a projection that
    // widened would put all four on every socket in the tenant.
    expect(Object.keys(query.select).sort()).toEqual([
      'attachments',
      'body',
      'contentType',
      'conversationId',
      'createdAt',
      'direction',
      'errorCode',
      'errorMessage',
      'id',
      'providerMessageId',
      'senderUserId',
      'sentAt',
      'status',
    ]);
  });

  it('does not reach the control plane when there is no url to make absolute', async () => {
    const harness = serviceFor(row({ attachments: [attachment()] }));

    await harness.messages.findForRelay(MESSAGE);

    // The common case — an inbound message, with or without a pending picture.
    expect(harness.originLookups).toBe(0);
  });

  it('resolves the tenant origin once when an attachment has stored bytes', async () => {
    const harness = serviceFor(
      row({
        attachments: [
          attachment({ url: '/api/v1/media/a/content', downloadState: 'stored' }),
          attachment({ id: 'b', url: '/api/v1/media/b/content', downloadState: 'stored' }),
        ],
      }),
    );

    const published = await harness.messages.findForRelay(MESSAGE);

    expect(harness.originLookups).toBe(1);
    expect(published?.attachments.map((each) => each.url)).toEqual([
      `${ORIGIN}/api/v1/media/a/content`,
      `${ORIGIN}/api/v1/media/b/content`,
    ]);
  });
});
