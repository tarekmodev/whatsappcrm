import { encodeKeysetCursor } from '../common/pagination/keyset-cursor';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { InvalidCursorError, MessageTemplateQueryService } from './message-template-query.service';

/**
 * The query the endpoint issues: what it filters on, how it pages, and what it
 * refuses. The `status: 'approved'` predicate is the one assertion here that is
 * a product rule rather than a mechanic — an agent cannot send anything else, so
 * offering one is a failed send.
 */

const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';

function template(id: string, createdAt: string) {
  return {
    id,
    whatsappBusinessAccountId: WABA_ROW_ID,
    name: 'order_update',
    language: 'en_US',
    category: 'UTILITY',
    status: 'approved' as const,
    components: null,
    providerTemplateId: '1001',
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

/** Only the fields these assertions read. */
interface FindManyArgs {
  where: Record<string, unknown>;
  orderBy: unknown;
  take: number;
  select: Record<string, boolean>;
}

describe('MessageTemplateQueryService', () => {
  let findMany: jest.Mock;
  let service: MessageTemplateQueryService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    service = new MessageTemplateQueryService({
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

  it('returns only approved templates, and offers no way to ask for others', async () => {
    await service.list({ limit: 25 });

    expect(args().where).toMatchObject({ status: 'approved' });
  });

  it('does not filter by tenant in the handler — RLS supplies that equality', async () => {
    await service.list({ limit: 25 });

    expect(args().where).not.toHaveProperty('tenantId');
  });

  it('narrows to one WABA when the composer asks for it', async () => {
    await service.list({ limit: 25, whatsappBusinessAccountId: WABA_ROW_ID });

    expect(args().where).toMatchObject({ whatsappBusinessAccountId: WABA_ROW_ID });
  });

  it('sorts on a total order, so a page boundary cannot skip a row', async () => {
    await service.list({ limit: 25 });

    expect(args().orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('selects exactly the published columns and nothing wider', async () => {
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

  describe('paging', () => {
    it('asks for one more row than requested, rather than counting the table', async () => {
      await service.list({ limit: 25 });

      expect(args().take).toBe(26);
    });

    it('returns the page and a cursor when there is more', async () => {
      findMany.mockResolvedValue([
        template('a', '2026-08-10T09:00:00.000Z'),
        template('b', '2026-08-10T08:00:00.000Z'),
        template('c', '2026-08-10T07:00:00.000Z'),
      ]);

      const result = await service.list({ limit: 2 });

      expect(result.items.map((item) => item.id)).toEqual(['a', 'b']);
      expect(result.nextCursor).toBe(
        encodeKeysetCursor({ sortValue: '2026-08-10T08:00:00.000Z', id: 'b' }),
      );
    });

    it('reports the end of the feed as a null cursor', async () => {
      findMany.mockResolvedValue([template('a', '2026-08-10T09:00:00.000Z')]);

      await expect(service.list({ limit: 25 })).resolves.toMatchObject({ nextCursor: null });
    });

    it('resumes strictly after the cursor row, with the id breaking a tie', async () => {
      const cursor = encodeKeysetCursor({ sortValue: '2026-08-10T08:00:00.000Z', id: 'b' });

      await service.list({ limit: 25, cursor });

      const createdAt = new Date('2026-08-10T08:00:00.000Z');

      expect(args().where.OR).toEqual([
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: 'b' } },
      ]);
    });

    it.each([
      ['a cursor that is not decodable', 'not-a-cursor'],
      [
        'a cursor whose sort value is not a timestamp',
        encodeKeysetCursor({ sortValue: 'yesterday', id: 'b' }),
      ],
    ])('rejects %s rather than silently re-reading the first page', async (_case, cursor) => {
      await expect(service.list({ limit: 25, cursor })).rejects.toBeInstanceOf(InvalidCursorError);
      expect(findMany).not.toHaveBeenCalled();
    });
  });
});
