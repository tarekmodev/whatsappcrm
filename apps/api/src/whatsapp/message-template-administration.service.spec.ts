import { encodeKeysetCursor } from '../common/pagination/keyset-cursor';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { MessageTemplateAdministrationService } from './message-template-administration.service';
import { InvalidCursorError } from './message-template-cursor';

/**
 * The query behind `GET /api/v1/whatsapp/message-templates`.
 *
 * The assertions that carry the story are the first two: this read applies no
 * status filter of its own, and it drops nothing after the read. Either one
 * quietly reintroduced would put the surface back to explaining a gap by having
 * the same gap.
 */

const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';

/** Real uuids: the cursor helper refuses an id that is not one. */
const ID_A = '80444444-4444-7444-8444-4444444444a1';
const ID_B = '80444444-4444-7444-8444-4444444444b2';
const ID_C = '80444444-4444-7444-8444-4444444444c3';

function template(id: string, name: string, status = 'approved', components: unknown = null) {
  return {
    id,
    whatsappBusinessAccountId: WABA_ROW_ID,
    name,
    language: 'en_US',
    category: 'UTILITY',
    status,
    components,
    providerTemplateId: '1001',
    createdAt: new Date('2026-08-10T09:00:00.000Z'),
    updatedAt: new Date('2026-08-10T09:00:00.000Z'),
  };
}

function cursorFor(name: string, language: string, id: string) {
  return encodeKeysetCursor({ sortValues: [name, language], id });
}

/** Only the fields these assertions read. */
interface FindManyArgs {
  where: Record<string, unknown>;
  orderBy: unknown;
  take: number;
  select: Record<string, boolean>;
}

describe('MessageTemplateAdministrationService', () => {
  let findMany: jest.Mock;
  let service: MessageTemplateAdministrationService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    service = new MessageTemplateAdministrationService({
      messageTemplate: { findMany },
    } as unknown as TenantPrisma);
  });

  function args(): FindManyArgs {
    const [call] = findMany.mock.calls as [FindManyArgs][];

    if (call === undefined) {
      throw new Error('findMany was never called');
    }

    return call[0];
  }

  it('constrains no status unless the caller asked for one', async () => {
    // The reason this surface exists. A default here would hide exactly the
    // templates it was built to show.
    await service.list({ limit: 25 });

    expect(args().where).not.toHaveProperty('status');
  });

  it('returns the templates the composer hides, rather than filtering them again', async () => {
    const quickReply = [
      { type: 'BODY', text: 'Hello.' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY' }] },
    ];
    findMany.mockResolvedValue([
      template(ID_A, 'appointment_reminder', 'rejected'),
      template(ID_B, 'order_update', 'approved', quickReply),
    ]);

    const result = await service.list({ limit: 25 });

    expect(result.items.map((item) => item.row.id)).toEqual([ID_A, ID_B]);
  });

  it('narrows to one status when asked', async () => {
    await service.list({ limit: 25, status: 'rejected' });

    expect(args().where).toMatchObject({ status: 'rejected' });
  });

  it('does not filter by tenant in the handler — RLS supplies that equality', async () => {
    await service.list({ limit: 25 });

    expect(args().where).not.toHaveProperty('tenantId');
  });

  it("keeps the composer's ordering, so the two lists agree on where a row sits", async () => {
    await service.list({ limit: 25 });

    expect(args().orderBy).toEqual([{ name: 'asc' }, { language: 'asc' }, { id: 'asc' }]);
  });

  it('filters by business account, which is what an administrator holds', async () => {
    await service.list({ limit: 25, whatsappBusinessAccountId: WABA_ROW_ID });

    expect(args().where).toMatchObject({ whatsappBusinessAccountId: WABA_ROW_ID });
  });

  it('matches a name prefix when one is given', async () => {
    await service.list({ limit: 25, q: 'order' });

    expect(args().where).toMatchObject({ name: { startsWith: 'order' } });
  });

  it('selects exactly the columns the response is built from and nothing wider', async () => {
    await service.list({ limit: 25 });

    expect(Object.keys(args().select).sort()).toEqual([
      'category',
      'components',
      'createdAt',
      'id',
      'language',
      'name',
      'providerTemplateId',
      'status',
      'updatedAt',
      'whatsappBusinessAccountId',
    ]);
  });

  it('derives the component summary, so the response can say why a row is blocked', async () => {
    findMany.mockResolvedValue([
      template(ID_A, 'order_update', 'approved', [
        { type: 'BODY', text: 'Order {{1}} ships {{2}}' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY' }] },
      ]),
    ]);

    const [item] = (await service.list({ limit: 25 })).items;

    expect(item?.summary).toMatchObject({
      bodyText: 'Order {{1}} ships {{2}}',
      parameterCount: 2,
      requiresButtonParameters: true,
    });
  });

  describe('paging', () => {
    it('asks for one more row than requested, rather than counting the table', async () => {
      await service.list({ limit: 25 });

      expect(args().take).toBe(26);
    });

    it('returns the page and a cursor when there is more', async () => {
      findMany.mockResolvedValue([
        template(ID_A, 'appointment_reminder'),
        template(ID_B, 'order_update'),
        template(ID_C, 'shipping_update'),
      ]);

      const result = await service.list({ limit: 2 });

      expect(result.items.map((item) => item.row.id)).toEqual([ID_A, ID_B]);
      expect(result.nextCursor).toBe(cursorFor('order_update', 'en_US', ID_B));
    });

    it('fills the page it promised, because nothing is dropped after the read', async () => {
      // Unlike the composer's list, which shortens a page by the rows it
      // excludes. Here `limit` items means `limit` items.
      findMany.mockResolvedValue([
        template(ID_A, 'appointment_reminder', 'rejected'),
        template(ID_B, 'order_update', 'pending'),
      ]);

      await expect(service.list({ limit: 2 })).resolves.toMatchObject({ nextCursor: null });
      expect((await service.list({ limit: 2 })).items).toHaveLength(2);
    });

    it('resumes with an index start condition, not a nested disjunction', async () => {
      // Shared with the composer's list (`message-template-cursor.ts`): an
      // inclusive bound on the leading column minus the part of that name's tie
      // group already returned. A nested OR returns the same rows and cannot be
      // turned into one index start condition.
      await service.list({ limit: 25, cursor: cursorFor('order_update', 'en_US', ID_B) });

      expect(args().where).toMatchObject({
        name: { gte: 'order_update' },
        NOT: {
          name: 'order_update',
          OR: [{ language: { lt: 'en_US' } }, { language: 'en_US', id: { lte: ID_B } }],
        },
      });
    });

    it('refuses a cursor from a different sort key rather than paging from the wrong place', async () => {
      const oneColumnCursor = encodeKeysetCursor({ sortValues: ['order_update'], id: ID_B });

      await expect(service.list({ limit: 25, cursor: oneColumnCursor })).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
      expect(findMany).not.toHaveBeenCalled();
    });
  });
});
