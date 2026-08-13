import { encodeKeysetCursor } from '../common/pagination/keyset-cursor';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { InvalidCursorError } from './message-template-cursor';
import {
  MessageTemplateQueryService,
  UnknownWhatsAppAccountError,
} from './message-template-query.service';

/**
 * The query the endpoint issues: what it filters on, how it pages, and what it
 * refuses. The `status: 'approved'` predicate is the one assertion here that is
 * a product rule rather than a mechanic — an agent cannot send anything else, so
 * offering one is a failed send.
 */

const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';
const ACCOUNT_ROW_ID = '70444444-4444-7444-8444-444444444401';

/**
 * Row ids, and they are real uuids on purpose: the cursor helper refuses an id
 * that is not one, because every id column it filters on is `@db.Uuid`. A
 * fixture id of `'a'` would make a cursor these tests build undecodable.
 */
const ID_A = '80444444-4444-7444-8444-4444444444a1';
const ID_B = '80444444-4444-7444-8444-4444444444b2';
const ID_C = '80444444-4444-7444-8444-4444444444c3';

function template(id: string, name: string, language = 'en_US', components: unknown = null) {
  return {
    id,
    whatsappBusinessAccountId: WABA_ROW_ID,
    name,
    language,
    category: 'UTILITY',
    status: 'approved' as const,
    components,
    providerTemplateId: '1001',
    createdAt: new Date('2026-08-10T09:00:00.000Z'),
    updatedAt: new Date('2026-08-10T09:00:00.000Z'),
  };
}

/** A template the composer cannot fill, and the list therefore hides. */
function templateWithQuickReply(id: string, name: string) {
  return template(id, name, 'en_US', [
    { type: 'BODY', text: 'Hello.' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY' }] },
  ]);
}

/** The cursor this ordering emits: the `(name, language)` pair, plus the id. */
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

describe('MessageTemplateQueryService', () => {
  let findMany: jest.Mock;
  let findUnique: jest.Mock;
  let service: MessageTemplateQueryService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    findUnique = jest.fn().mockResolvedValue({ whatsappBusinessAccountId: WABA_ROW_ID });
    service = new MessageTemplateQueryService({
      messageTemplate: { findMany },
      whatsappAccount: { findUnique },
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

  it('sorts by name, so the picker reads as a list an agent can scan', async () => {
    await service.list({ limit: 25 });

    expect(args().orderBy).toEqual([{ name: 'asc' }, { language: 'asc' }, { id: 'asc' }]);
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

  describe('filtering by phone number', () => {
    it('resolves the number to its WABA rather than asking the caller for one', async () => {
      await service.list({ limit: 25, whatsappAccountId: ACCOUNT_ROW_ID });

      expect(findUnique).toHaveBeenCalledWith({
        where: { id: ACCOUNT_ROW_ID },
        select: { whatsappBusinessAccountId: true },
      });
      expect(args().where).toMatchObject({ whatsappBusinessAccountId: WABA_ROW_ID });
    });

    it('rejects a number the tenant does not hold, rather than listing every template', async () => {
      // RLS makes another tenant's number indistinguishable from one that does
      // not exist. Both must fail closed: falling back to an unfiltered list
      // would offer templates that cannot be sent on the number asked about.
      findUnique.mockResolvedValue(null);

      await expect(
        service.list({ limit: 25, whatsappAccountId: ACCOUNT_ROW_ID }),
      ).rejects.toBeInstanceOf(UnknownWhatsAppAccountError);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('still serves the administrative read that names a WABA directly', async () => {
      await service.list({ limit: 25, whatsappBusinessAccountId: WABA_ROW_ID });

      expect(findUnique).not.toHaveBeenCalled();
      expect(args().where).toMatchObject({ whatsappBusinessAccountId: WABA_ROW_ID });
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

    it('reports the end of the feed as a null cursor', async () => {
      findMany.mockResolvedValue([template(ID_A, 'order_update')]);

      await expect(service.list({ limit: 25 })).resolves.toMatchObject({ nextCursor: null });
    });

    it('resumes with an index start condition, not a nested disjunction', async () => {
      // 0002 rules the shape as well as the result: an inclusive bound on the
      // leading column, minus the part of its tie group already returned. The
      // nested OR returns the same rows and cannot be an index start condition,
      // so its cost grows with how far into the list the cursor sits.
      await service.list({ limit: 25, cursor: cursorFor('order_update', 'en_US', ID_B) });

      expect(args().where).toMatchObject({
        name: { gte: 'order_update' },
        NOT: {
          name: 'order_update',
          OR: [{ language: { lt: 'en_US' } }, { language: 'en_US', id: { lte: ID_B } }],
        },
      });
    });

    it('keeps the name prefix and the cursor bound on one filter', async () => {
      // Two `name` keys in the same object and the second silently replaces the
      // first — dropping either the search or the resume point.
      await service.list({
        limit: 25,
        q: 'order',
        cursor: cursorFor('order_update', 'en_US', ID_B),
      });

      expect(args().where.name).toEqual({ startsWith: 'order', gte: 'order_update' });
    });

    it.each([
      ['a cursor that is not decodable', 'not-a-cursor'],
      [
        'a cursor from a list that sorts on one column',
        encodeKeysetCursor({ sortValues: ['2026-08-10T08:00:00.000Z'], id: ID_B }),
      ],
      [
        // Otherwise it reaches `id: { lte: … }` against a `@db.Uuid` column and
        // the driver's refusal surfaces as a 500, where every other malformed
        // cursor answers `validation_failed`.
        'a cursor whose id is not a uuid',
        Buffer.from(
          JSON.stringify({ v: 1, k: ['order_update', 'en_US'], id: 'b' }),
          'utf8',
        ).toString('base64url'),
      ],
      [
        'a cursor carrying more sort values than this order has columns',
        encodeKeysetCursor({ sortValues: ['order_update', 'en_US', 'extra'], id: ID_B }),
      ],
    ])('rejects %s rather than silently re-reading the first page', async (_case, cursor) => {
      await expect(service.list({ limit: 25, cursor })).rejects.toBeInstanceOf(InvalidCursorError);
      expect(findMany).not.toHaveBeenCalled();
    });
  });

  describe('templates the composer cannot send', () => {
    it('hides a template whose buttons take a parameter', async () => {
      findMany.mockResolvedValue([
        template(ID_A, 'appointment_reminder'),
        templateWithQuickReply(ID_B, 'order_update'),
      ]);

      const result = await service.list({ limit: 25 });

      expect(result.items.map((item) => item.row.id)).toEqual([ID_A]);
    });

    it('takes the cursor from the last row read, not the last row returned', async () => {
      // Otherwise the next page resumes before a row this one already
      // considered, and the hidden template comes back around forever.
      findMany.mockResolvedValue([
        template(ID_A, 'appointment_reminder'),
        templateWithQuickReply(ID_B, 'order_update'),
        template(ID_C, 'shipping_update'),
      ]);

      const result = await service.list({ limit: 2 });

      expect(result.items.map((item) => item.row.id)).toEqual([ID_A]);
      expect(result.nextCursor).toBe(cursorFor('order_update', 'en_US', ID_B));
    });
  });
});
