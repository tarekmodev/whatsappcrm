import { Inject, Injectable } from '@nestjs/common';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetCursor,
} from '../common/pagination/keyset-cursor';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

/** Exactly the columns `MessageTemplateResponseSchema` publishes — nothing wider. */
const TEMPLATE_PROJECTION = {
  id: true,
  whatsappBusinessAccountId: true,
  name: true,
  language: true,
  category: true,
  status: true,
  components: true,
  providerTemplateId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type ListedMessageTemplate = Prisma.MessageTemplateGetPayload<{
  select: typeof TEMPLATE_PROJECTION;
}>;

export interface ListMessageTemplatesQuery {
  limit: number;
  cursor?: string;
  whatsappBusinessAccountId?: string;
}

export interface MessageTemplatePage {
  items: ListedMessageTemplate[];
  nextCursor: string | null;
}

/** Raised for a cursor this build cannot act on. The controller turns it into `validation_failed`. */
export class InvalidCursorError extends Error {
  constructor() {
    super('The cursor is not valid. Start from the first page.');
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Reads the templates an agent may actually send (TAR-20a).
 *
 * ## Approved only, and not negotiable
 *
 * Meta refuses a send on a `pending`, `rejected`, `paused` or `disabled`
 * template, so offering one produces a failed send and a confused agent. The
 * filter is therefore fixed in the query rather than exposed as a parameter —
 * there is no request that can reach an unapproved template through this
 * service. Template *administration*, which does need to show the rejected ones,
 * is a different read with a different permission.
 *
 * ## Isolation
 *
 * There is no `tenantId` in the `where` clause, and that is deliberate rather
 * than an oversight: `TenantPrisma` runs every statement behind
 * `set_config('app.tenant_id', …)`, and TAR-48's `tenant_isolation` policy adds
 * the equality itself. Repeating it in the handler would be the belt to RLS's
 * braces, but it would also be the thing a future query forgets — which is
 * exactly why TAR-39 put the guarantee in the database.
 *
 * ## Query cost
 *
 * One statement per page, `take: limit + 1` to decide whether there is another
 * page without a second `count(*)`. It reads
 * `message_templates (tenant_id, status, created_at DESC, id DESC)` — added by
 * `20260810180000_message_template_list_index` — which covers the RLS equality,
 * the status filter and both sort keys, so the page is an index range scan with
 * no sort node. The optional WABA filter is a heap-side recheck on an already
 * small set.
 */
@Injectable()
export class MessageTemplateQueryService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  async list(query: ListMessageTemplatesQuery): Promise<MessageTemplatePage> {
    const cursor = readCursor(query.cursor);

    const rows = await this.prisma.messageTemplate.findMany({
      where: {
        status: 'approved',
        ...(query.whatsappBusinessAccountId === undefined
          ? {}
          : { whatsappBusinessAccountId: query.whatsappBusinessAccountId }),
        ...(cursor === null ? {} : { OR: keysetPredicate(cursor) }),
      },
      // `(created_at DESC, id DESC)`. The id is not decoration: two templates
      // written in the same millisecond by one sync are otherwise
      // indistinguishable to the predicate above, and one of them would be
      // skipped at a page boundary.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One more than asked for: its existence is the answer to "is there another
      // page", which is cheaper than counting a table that a sync appends to.
      take: query.limit + 1,
      select: TEMPLATE_PROJECTION,
    });

    const items = rows.slice(0, query.limit);
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeKeysetCursor({ sortValue: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }
}

/** The cursor as this query uses it: the sort value already parsed as an instant. */
interface TemplateCursor {
  createdAt: Date;
  id: string;
}

/**
 * A cursor that decodes but whose sort value is not a timestamp is rejected
 * here rather than passed on as an `Invalid Date`. Prisma would refuse it too,
 * but as a 500 — and a corrupted cursor is bad input, not a fault.
 */
function readCursor(value: string | undefined): TemplateCursor | null {
  if (value === undefined) {
    return null;
  }

  const cursor: KeysetCursor | null = decodeKeysetCursor(value);

  if (cursor === null) {
    throw new InvalidCursorError();
  }

  const createdAt = new Date(cursor.sortValue);

  if (Number.isNaN(createdAt.getTime())) {
    throw new InvalidCursorError();
  }

  return { createdAt, id: cursor.id };
}

/**
 * "Strictly after the cursor row in `(created_at DESC, id DESC)` order" — an
 * older row, or the same instant with a lower id.
 */
function keysetPredicate(cursor: TemplateCursor): Prisma.MessageTemplateWhereInput[] {
  return [
    { createdAt: { lt: cursor.createdAt } },
    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
  ];
}
