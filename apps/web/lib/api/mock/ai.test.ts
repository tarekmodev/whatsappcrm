import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiConfigResponseSchema,
  KnowledgeDocumentResponseSchema,
  HandoffContextResponseSchema,
  type AiConfigResponse,
  type ConversationResponse,
  type CursorPage,
  type HandoffContextResponse,
  type KnowledgeDocumentResponse,
  type TenantRole,
} from '@whatsappcrm/contracts';

/**
 * The chatbot half of the mock transport (TAR-28).
 *
 * Two things are worth exercising here rather than assuming, because the whole
 * console rests on them: **readiness is derived**, so it cannot claim the bot is
 * answering while the knowledge base is empty, and **every read is
 * tenant-scoped**, so a second tenant's material can never reach this one.
 *
 * `server-only` throws outside a React Server Component, and `next/headers`
 * needs a request scope — both are stubbed so these stay plain unit tests.
 */

vi.mock('server-only', () => ({}));

let currentRole: TenantRole = 'admin';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'wac_role_stub' ? { name, value: currentRole } : undefined),
    }),
}));

const { handleMockRequest } = await import('./handlers');
const { resetMockState } = await import('./store');
const { MOCK_IDS } = await import('./fixtures');
const { ApiRequestError } = await import('@/lib/api/http');

function asRole(role: TenantRole): void {
  currentRole = role;
}

beforeEach(() => {
  resetMockState();
  asRole('admin');
});

async function listDocuments(): Promise<CursorPage<KnowledgeDocumentResponse>> {
  return (await handleMockRequest({
    method: 'GET',
    path: '/v1/knowledge-documents?limit=100',
  })) as CursorPage<KnowledgeDocumentResponse>;
}

async function readConfig(): Promise<AiConfigResponse> {
  return AiConfigResponseSchema.parse(
    await handleMockRequest({ method: 'GET', path: '/v1/ai/config' }),
  );
}

describe('knowledge base', () => {
  it('lists this tenant’s entries and never another’s', async () => {
    const page = await listDocuments();

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((document) => document.id)).not.toContain(
      MOCK_IDS.knowledgeDocuments.otherTenant,
    );
  });

  it('answers 404, not 403, for another tenant’s entry so nothing can be enumerated', async () => {
    const attempt = handleMockRequest({
      method: 'GET',
      path: `/v1/knowledge-documents/${MOCK_IDS.knowledgeDocuments.otherTenant}`,
    });

    await expect(attempt).rejects.toMatchObject({ code: 'not_found' });
    await expect(attempt).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('omits the body from list items and returns it on the single read', async () => {
    // A page of entries each holding up to 256 KiB is a response nobody wants.
    const page = await listDocuments();
    const listed = page.items.find(
      (document) => document.id === MOCK_IDS.knowledgeDocuments.returnsPolicy,
    );

    // Absent, not blanked: an empty string reads as "this entry has no text",
    // and an editor prefilled from it would save that emptiness back.
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('content');

    const single = KnowledgeDocumentResponseSchema.parse(
      await handleMockRequest({
        method: 'GET',
        path: `/v1/knowledge-documents/${MOCK_IDS.knowledgeDocuments.returnsPolicy}`,
      }),
    );

    expect(single.content.length).toBeGreaterThan(0);
  });

  it('creates an entry as pending, because the bot cannot use it until it is indexed', async () => {
    const created = KnowledgeDocumentResponseSchema.parse(
      await handleMockRequest({
        method: 'POST',
        path: '/v1/knowledge-documents',
        body: { title: 'Opening hours', content: 'Sunday to Thursday, 09:00 to 18:00.' },
      }),
    );

    expect(created.status).toBe('pending');
    expect(created.chunkCount).toBe(0);
  });

  it('sends an entry back to pending when its text changes, and leaves it alone when only the title does', async () => {
    const path = `/v1/knowledge-documents/${MOCK_IDS.knowledgeDocuments.returnsPolicy}`;

    const renamed = KnowledgeDocumentResponseSchema.parse(
      await handleMockRequest({ method: 'PATCH', path, body: { title: 'Returns policy' } }),
    );

    expect(renamed.status).toBe('indexed');

    const rewritten = KnowledgeDocumentResponseSchema.parse(
      await handleMockRequest({ method: 'PATCH', path, body: { content: 'Fourteen days.' } }),
    );

    expect(rewritten.status).toBe('pending');
    expect(rewritten.chunkCount).toBe(0);
  });

  /**
   * The mock is a transport, not a per-feature fake (`lib/api/http.ts`), and
   * `NEXT_PUBLIC_USE_MOCK_API=true` is the shipped default — so a field it
   * handles differently from the API is a bug an admin meets on the default
   * local environment, not a test-only inaccuracy.
   *
   * `sourceUrl` is the one field on this input that is nullable as well as
   * optional, which makes it the one field where `??` is the wrong operator.
   */
  describe('a source URL', () => {
    const path = `/v1/knowledge-documents/${MOCK_IDS.knowledgeDocuments.returnsPolicy}`;

    async function patch(body: unknown): Promise<KnowledgeDocumentResponse> {
      return KnowledgeDocumentResponseSchema.parse(
        await handleMockRequest({ method: 'PATCH', path, body }),
      );
    }

    it('is cleared by an explicit null, which is the only way to say "there is no link"', async () => {
      expect((await patch({ sourceUrl: null })).sourceUrl).toBeNull();

      // Read back rather than trusted from the response: the point is that the
      // clear was *stored*, not that one handler returned what it was handed.
      const reread = KnowledgeDocumentResponseSchema.parse(
        await handleMockRequest({ method: 'GET', path }),
      );

      expect(reread.sourceUrl).toBeNull();
    });

    it('is left alone when the key is absent', async () => {
      const renamed = await patch({ title: 'Returns policy' });

      expect(renamed.sourceUrl).toBe('https://northwind.example/help/returns');
    });

    it('is replaced by a new one', async () => {
      const replaced = await patch({ sourceUrl: 'https://northwind.example/help/refunds' });

      expect(replaced.sourceUrl).toBe('https://northwind.example/help/refunds');
    });

    it('does not reindex the entry, because it never reached the chunks', async () => {
      const cleared = await patch({ sourceUrl: null });

      expect(cleared.status).toBe('indexed');
      expect(cleared.chunkCount).toBeGreaterThan(0);
    });
  });

  it('indexes an entry on demand, splitting it on blank lines', async () => {
    const created = KnowledgeDocumentResponseSchema.parse(
      await handleMockRequest({
        method: 'POST',
        path: '/v1/knowledge-documents',
        body: { title: 'Delivery', content: 'Inside the Gulf: five days.\n\nOutside: ten days.' },
      }),
    );

    const indexed = KnowledgeDocumentResponseSchema.parse(
      await handleMockRequest({
        method: 'POST',
        path: `/v1/knowledge-documents/${created.id}/reindex`,
      }),
    );

    expect(indexed.status).toBe('indexed');
    expect(indexed.chunkCount).toBe(2);
  });

  it('refuses a write from a role without ai:write', async () => {
    asRole('agent');

    const attempt = handleMockRequest({
      method: 'POST',
      path: '/v1/knowledge-documents',
      body: { title: 'Anything', content: 'Anything.' },
    });

    await expect(attempt).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('chatbot configuration', () => {
  it('reports ready while the knowledge base holds an indexed entry', async () => {
    const config = await readConfig();

    expect(config.readiness.ready).toBe(true);
    expect(config.readiness.blockers).toEqual([]);
    expect(config.readiness.indexedDocumentCount).toBeGreaterThan(0);
  });

  it('reports not-ready the moment the last indexed entry is deleted', async () => {
    // ADR 0010 decision 4: the empty-knowledge-base rule is structural, so
    // readiness has to be derived rather than stored — a cached `ready: true`
    // here would be the console claiming replies that cannot happen.
    const page = await listDocuments();

    for (const document of page.items.filter((item) => item.status === 'indexed')) {
      await handleMockRequest({
        method: 'DELETE',
        path: `/v1/knowledge-documents/${document.id}`,
      });
    }

    const config = await readConfig();

    expect(config.readiness.ready).toBe(false);
    expect(config.readiness.blockers).toContain('no_indexed_documents');
    expect(config.readiness.indexedDocumentCount).toBe(0);
  });

  it('reports the switch as a blocker of its own', async () => {
    await handleMockRequest({
      method: 'PATCH',
      path: '/v1/ai/config',
      body: { isEnabled: false },
    });

    const config = await readConfig();

    expect(config.readiness.blockers).toContain('disabled');
  });

  it('publishes the model allowlist with its prices', async () => {
    const config = await readConfig();

    expect(config.availableModels.length).toBeGreaterThan(0);
    expect(config.availableModels.filter((option) => option.isDefault)).toHaveLength(1);

    for (const option of config.availableModels) {
      expect(option.inputPricePerMTokUsd).toBeGreaterThan(0);
      expect(option.outputPricePerMTokUsd).toBeGreaterThan(0);
    }
  });

  it('refuses a value outside the contract’s bounds', async () => {
    const attempt = handleMockRequest({
      method: 'PATCH',
      path: '/v1/ai/config',
      body: { minConfidence: 1.5 },
    });

    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('handoff', () => {
  it('returns the summary for a handed-over conversation', async () => {
    const handoff = HandoffContextResponseSchema.parse(
      await handleMockRequest({
        method: 'GET',
        path: `/v1/conversations/${MOCK_IDS.conversations.handedOff}/handoff`,
      }),
    );

    expect(handoff.reason).toBe('customer_requested');
    expect(handoff.botReplyCount).toBe(2);
    expect(handoff.citedDocuments).not.toHaveLength(0);
  });

  it('rebuilds the exchange from the thread rather than a stored copy', async () => {
    // A stored transcript would drift from the messages rendered beside it, and
    // the panel that disagreed would be the wrong one.
    const handoff = (await handleMockRequest({
      method: 'GET',
      path: `/v1/conversations/${MOCK_IDS.conversations.handedOff}/handoff`,
    })) as HandoffContextResponse;

    expect(handoff.botExchange.map((message) => message.id)).toEqual([
      MOCK_IDS.messages.handedOffFirstBotReply,
      MOCK_IDS.messages.handedOffSecondQuestion,
      MOCK_IDS.messages.handedOffSecondBotReply,
    ]);
    expect(handoff.botExchange.map((message) => message.id)).not.toContain(
      handoff.triggerMessageId,
    );
  });

  it('answers 404 for a conversation the chatbot never handed over', async () => {
    const attempt = handleMockRequest({
      method: 'GET',
      path: `/v1/conversations/${MOCK_IDS.conversations.assignedToAmina}/handoff`,
    });

    await expect(attempt).rejects.toMatchObject({ code: 'not_found' });
  });

  it('takes a bot-active conversation from the chatbot', async () => {
    const conversation = (await handleMockRequest({
      method: 'POST',
      path: `/v1/conversations/${MOCK_IDS.conversations.unassigned}/handoff`,
      body: {},
    })) as ConversationResponse;

    expect(conversation.botState).toBe('handed_off');
    expect(conversation.botHandling).toBe(false);
  });

  it('is a no-op rather than a conflict on a second press', async () => {
    const path = `/v1/conversations/${MOCK_IDS.conversations.unassigned}/handoff`;

    await handleMockRequest({ method: 'POST', path, body: {} });

    const again = (await handleMockRequest({
      method: 'POST',
      path,
      body: {},
    })) as ConversationResponse;

    expect(again.botState).toBe('handed_off');
  });
});
