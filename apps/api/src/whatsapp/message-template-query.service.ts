import { Inject, Injectable } from '@nestjs/common';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetCursor,
} from '../common/pagination/keyset-cursor';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

/** Exactly the columns the response is built from — nothing wider. */
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
  /** A phone number row id. Resolved to its WABA here — the caller never holds one. */
  whatsappAccountId?: string;
  whatsappBusinessAccountId?: string;
  /** Name prefix. */
  q?: string;
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
 * Raised when `whatsappAccountId` names no number this tenant holds. Bad input
 * rather than an empty page: the composer takes this id from a conversation it
 * has just read, so a miss means the id is wrong, and answering "no templates"
 * would send an agent looking for a template that was never missing.
 *
 * A number belonging to another tenant is indistinguishable from one that does
 * not exist — RLS hides it, so both arrive here as the same miss and produce the
 * same message.
 */
export class UnknownWhatsAppAccountError extends Error {
  constructor() {
    super('No connected WhatsApp number matches whatsappAccountId.');
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * Reads the templates an agent may actually send (TAR-20a; shape ruled in
 * `docs/architecture/0002-architecture-and-api-contract.md`, amendment 1).
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
 * ## Filtering by number, not by business account
 *
 * A conversation names a phone number, and only the templates of the WABA behind
 * that number can be sent on it. The caller therefore passes the number and this
 * service resolves the WABA — the same direction the send path already resolves
 * it in. `whatsappBusinessAccountId` stays for the administrative read that
 * spans a WABA's numbers; the contract refuses both at once.
 *
 * ## Isolation
 *
 * There is no `tenantId` in either `where` clause, and that is deliberate rather
 * than an oversight: `TenantPrisma` runs every statement behind
 * `set_config('app.tenant_id', …)`, and TAR-48's `tenant_isolation` policy adds
 * the equality itself. It covers the number lookup as well as the page, so a
 * `whatsappAccountId` belonging to another tenant resolves to nothing rather
 * than to that tenant's WABA.
 *
 * ## Query cost
 *
 * One statement per page, plus one primary-key lookup when a number is named.
 * `take: limit + 1` decides whether there is another page without a `count(*)`.
 * The page reads `message_templates (tenant_id, status, name, language, id)` —
 * added by `20260810180000_message_template_list_index` — which covers the RLS
 * equality, the status filter and all three sort keys, so it is an index range
 * scan with no sort node. `q` extends that range under the C collation this
 * repo provisions; under a linguistic collation it degrades to a filter over the
 * already-narrow approved set, never to a sequential scan. The WABA equality is
 * a heap-side recheck on the same small set.
 */
@Injectable()
export class MessageTemplateQueryService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  async list(query: ListMessageTemplatesQuery): Promise<MessageTemplatePage> {
    const cursor = readCursor(query.cursor);
    const whatsappBusinessAccountId = await this.resolveBusinessAccountId(query);

    const rows = await this.prisma.messageTemplate.findMany({
      where: {
        status: 'approved',
        ...(whatsappBusinessAccountId === undefined ? {} : { whatsappBusinessAccountId }),
        ...(query.q === undefined ? {} : { name: { startsWith: query.q } }),
        ...(cursor === null ? {} : { OR: keysetPredicate(cursor) }),
      },
      // `(name ASC, language ASC, id ASC)`. An agent scans this picker looking
      // for `order_update`, not for whatever Meta approved most recently. The id
      // is not decoration: `(name, language)` is unique only within a WABA, so a
      // list spanning two of them can hold the same pair twice, and one of the
      // rows would be skipped at a page boundary without a total order.
      orderBy: [{ name: 'asc' }, { language: 'asc' }, { id: 'asc' }],
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
          ? encodeKeysetCursor({ sortValue: encodeSortValue(last), id: last.id })
          : null,
    };
  }

  /**
   * The number, when one is named, otherwise whatever WABA the caller asked for.
   * The contract rejects both together, so there is no precedence to decide here.
   */
  private async resolveBusinessAccountId(
    query: ListMessageTemplatesQuery,
  ): Promise<string | undefined> {
    if (query.whatsappAccountId === undefined) {
      return query.whatsappBusinessAccountId;
    }

    const account = await this.prisma.whatsappAccount.findUnique({
      where: { id: query.whatsappAccountId },
      select: { whatsappBusinessAccountId: true },
    });

    if (account === null) {
      throw new UnknownWhatsAppAccountError();
    }

    return account.whatsappBusinessAccountId;
  }
}

/** The cursor as this query uses it: the row's position in `(name, language, id)`. */
interface TemplateCursor {
  name: string;
  language: string;
  id: string;
}

/**
 * The sort key spans two columns, and `KeysetCursor` carries one sort value plus
 * the id. It is serialised as a JSON pair rather than joined with a separator
 * because a template name and a language tag are both free text out of Meta, and
 * any separator character they could contain would split the cursor in the wrong
 * place. The encoding stays local to this query: the shared helper still owns the
 * envelope, the version and the base64url.
 */
function encodeSortValue(row: { name: string; language: string }): string {
  return JSON.stringify([row.name, row.language]);
}

/**
 * A cursor that decodes but whose sort value is not the pair this query emits is
 * rejected here rather than passed on. Prisma would refuse an `undefined`
 * comparison too, but as a 500 — and a corrupted cursor is bad input, not a
 * fault. This is also what rejects a cursor issued by the previous
 * `created_at DESC` ordering: its sort value is a timestamp string, not a pair.
 */
function readCursor(value: string | undefined): TemplateCursor | null {
  if (value === undefined) {
    return null;
  }

  const cursor: KeysetCursor | null = decodeKeysetCursor(value);

  if (cursor === null) {
    throw new InvalidCursorError();
  }

  const [name, language] = parseSortValue(cursor.sortValue);

  return { name, language, id: cursor.id };
}

function parseSortValue(sortValue: string): [string, string] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(sortValue);
  } catch {
    throw new InvalidCursorError();
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string'
  ) {
    throw new InvalidCursorError();
  }

  return [parsed[0], parsed[1]];
}

/**
 * "Strictly after the cursor row in `(name ASC, language ASC, id ASC)` order" —
 * a later name, or the same name with a later language, or both equal with a
 * higher id.
 */
function keysetPredicate(cursor: TemplateCursor): Prisma.MessageTemplateWhereInput[] {
  return [
    { name: { gt: cursor.name } },
    { name: cursor.name, language: { gt: cursor.language } },
    { name: cursor.name, language: cursor.language, id: { gt: cursor.id } },
  ];
}
