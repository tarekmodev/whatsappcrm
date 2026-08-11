import type { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { MessageTemplateSyncService } from './message-template-sync.service';
import type {
  MetaCloudApiClient,
  MetaMessageTemplate,
  MetaMessageTemplatePage,
} from './meta-cloud-api.client';
import type { WhatsAppCredentialResolver } from './whatsapp-credential.resolver';

/**
 * Reconciliation, with Meta and the database both mocked: what is created, what
 * is updated, what is refused, and where the transaction boundaries fall.
 */

const TENANT_ID = '50444444-4444-7444-8444-444444444401';
const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';
const WABA_ID = '102290129340398';
const ACCESS_TOKEN = 'a-meta-access-token';

function metaTemplate(overrides: Partial<MetaMessageTemplate> = {}): MetaMessageTemplate {
  return {
    name: 'order_update',
    language: 'en_US',
    category: 'UTILITY',
    status: 'approved',
    components: [{ type: 'BODY', text: 'Order {{1}}' }],
    providerTemplateId: '1001',
    ...overrides,
  };
}

function page(templates: MetaMessageTemplate[], nextAfter: string | null = null) {
  return { templates, nextAfter } satisfies MetaMessageTemplatePage;
}

interface TransactionSpies {
  messageTemplate: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
}

describe('MessageTemplateSyncService', () => {
  let tx: TransactionSpies;
  let tenantTransaction: jest.Mock;
  let listMessageTemplates: jest.Mock;
  let service: MessageTemplateSyncService;

  beforeEach(() => {
    tx = {
      messageTemplate: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'created' }),
        update: jest.fn().mockResolvedValue({ id: 'updated' }),
      },
    };

    tenantTransaction = jest.fn(async (work: (client: TransactionSpies) => Promise<unknown>) =>
      work(tx),
    );
    listMessageTemplates = jest.fn().mockResolvedValue(page([]));

    const credentials = {
      whatsappBusinessAccountId: WABA_ROW_ID,
      wabaId: WABA_ID,
      accessToken: ACCESS_TOKEN,
    };

    service = new MessageTemplateSyncService(
      { $tenantTransaction: tenantTransaction } as unknown as TenantPrisma,
      { requireTenantId: () => TENANT_ID } as unknown as TenantContextService,
      {
        forBusinessAccount: jest.fn().mockResolvedValue(credentials),
        forBusinessAccountByWabaId: jest.fn().mockResolvedValue(credentials),
      } as unknown as WhatsAppCredentialResolver,
      { listMessageTemplates } as unknown as MetaCloudApiClient,
    );
  });

  it("asks Meta with the business account's own credential", async () => {
    await service.sync(WABA_ROW_ID);

    expect(listMessageTemplates).toHaveBeenCalledWith({
      wabaId: WABA_ID,
      accessToken: ACCESS_TOKEN,
      after: undefined,
    });
  });

  it('creates a template that has not been seen before', async () => {
    listMessageTemplates.mockResolvedValue(page([metaTemplate()]));

    const result = await service.sync(WABA_ROW_ID);

    expect(result).toMatchObject({ created: 1, updated: 0, skipped: 0, total: 1 });
    expect(tx.messageTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_ID,
          whatsappBusinessAccountId: WABA_ROW_ID,
          name: 'order_update',
          language: 'en_US',
          status: 'approved',
        }) as unknown,
      }),
    );
  });

  it('keys on the WABA as well as the name and language, per TAR-52', async () => {
    // Two WABAs under one tenant may each hold `order_update`/`en_US`. A key
    // without the WABA in it makes the second one collide with the first.
    listMessageTemplates.mockResolvedValue(page([metaTemplate()]));

    await service.sync(WABA_ROW_ID);

    expect(tx.messageTemplate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_whatsappBusinessAccountId_name_language: {
            tenantId: TENANT_ID,
            whatsappBusinessAccountId: WABA_ROW_ID,
            name: 'order_update',
            language: 'en_US',
          },
        },
      }),
    );
  });

  it('updates a template it already has, without moving it between tenants or WABAs', async () => {
    tx.messageTemplate.findUnique.mockResolvedValue({ id: 'existing' });
    listMessageTemplates.mockResolvedValue(page([metaTemplate({ status: 'paused' })]));

    const result = await service.sync(WABA_ROW_ID);

    expect(result).toMatchObject({ created: 0, updated: 1 });

    const [call] = tx.messageTemplate.update.mock.calls as [{ data: Record<string, unknown> }][];

    expect(call?.[0].data).toMatchObject({ status: 'paused' });
    expect(call?.[0].data).not.toHaveProperty('tenantId');
    expect(call?.[0].data).not.toHaveProperty('whatsappBusinessAccountId');
  });

  it('skips a status this build does not model rather than guessing at it', async () => {
    // Reporting an `IN_APPEAL` template as approved would put an unsendable
    // template in an agent's picker.
    listMessageTemplates.mockResolvedValue(page([metaTemplate({ status: null })]));

    const result = await service.sync(WABA_ROW_ID);

    expect(result).toMatchObject({ created: 0, updated: 0, skipped: 1, total: 1 });
    expect(tx.messageTemplate.create).not.toHaveBeenCalled();
  });

  it('follows Meta’s paging, and writes each page in its own transaction', async () => {
    listMessageTemplates
      .mockResolvedValueOnce(page([metaTemplate({ name: 'first' })], 'CURSOR2'))
      .mockResolvedValueOnce(page([metaTemplate({ name: 'second' })]));

    const result = await service.sync(WABA_ROW_ID);

    expect(result).toMatchObject({ created: 2, total: 2 });
    expect(listMessageTemplates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ after: 'CURSOR2' }),
    );
    // One transaction per page: a tenant with thousands of templates must not
    // hold a transaction open across every Meta round trip.
    expect(tenantTransaction).toHaveBeenCalledTimes(2);
  });

  it('never deletes a template that has stopped appearing in Meta’s list', async () => {
    listMessageTemplates.mockResolvedValue(page([]));

    await service.sync(WABA_ROW_ID);

    expect(Object.keys(tx.messageTemplate)).toEqual(['findUnique', 'create', 'update']);
  });

  it('writes SQL NULL, not JSON null, for a template with no components', async () => {
    listMessageTemplates.mockResolvedValue(page([metaTemplate({ components: null })]));

    await service.sync(WABA_ROW_ID);

    const [call] = tx.messageTemplate.create.mock.calls as [{ data: Record<string, unknown> }][];

    expect(call?.[0].data.components).toBe(Prisma.DbNull);
  });

  it('resolves by Meta’s id when the caller has that instead', async () => {
    await service.syncByWabaId(WABA_ID);

    expect(listMessageTemplates).toHaveBeenCalledWith(expect.objectContaining({ wabaId: WABA_ID }));
  });
});
