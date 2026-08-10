import { Inject, Injectable } from '@nestjs/common';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetCursor,
} from '../common/pagination/keyset-cursor';
import type { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  describeTemplateComponents,
  type MessageTemplateComponentSummary,
} from './message-template-components';

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

/**
 * A row with what its component tree says, read once. The controller needs the
 * summary to build the response and this service needs it to apply the button
 * exclusion, so it is derived here and carried, rather than parsed twice.
 */
export interface ListedTemplate {
  row: ListedMessageTemplate;
  summary: MessageTemplateComponentSummary;
}

export interface MessageTemplatePage {
  items: ListedTemplate[];
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
 * ## Sendable only, for the same reason
 *
 * A template whose buttons take a parameter cannot be completed by any composer
 * TAR-20 builds, so it is dropped from the page — the same rule as approved-only,
 * applied to the other way a listed template turns out to be unsendable. It is a
 * property of Meta's component tree rather than of a column, so it is applied
 * after the read instead of in the `where`: expressing it in SQL means either a
 * raw JSONB predicate in place of the typed query, or a denormalised flag that
 * a template sync has to keep true. Both cost more than they save while a page
 * is capped at 100 rows.
 *
 * The consequence is published: a page may hold fewer than `limit` items while
 * `nextCursor` is non-null. What it may never do is skip a row, which is why the
 * cursor comes from the last row *read* rather than the last row returned.
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
        // One `name` filter, not two: the prefix and the cursor's lower bound
        // both constrain the same column, and a second `name` key would silently
        // replace the first.
        name: {
          ...(query.q === undefined ? {} : { startsWith: query.q }),
          ...(cursor === null ? {} : { gte: cursor.name }),
        },
        ...(cursor === null ? {} : { NOT: alreadyReturned(cursor) }),
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

    // The page this request covers, before the button exclusion. The cursor is
    // taken from its last row rather than from the last row returned, so the
    // next page resumes after everything already considered — including a row
    // dropped below. Dropping rows shortens a page; it must never move where the
    // next one starts.
    const window = rows.slice(0, query.limit);
    const last = window.at(-1);

    return {
      items: window
        .map((row) => ({ row, summary: describeTemplateComponents(row.components) }))
        .filter(({ summary }) => !summary.requiresButtonParameters),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeKeysetCursor({ sortValues: [last.name, last.language], id: last.id })
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
 * A cursor whose sort key is not the `[name, language]` pair this ordering emits
 * is rejected here rather than passed on. Prisma would refuse an `undefined`
 * comparison too, but as a 500 — and a corrupted cursor is bad input, not a
 * fault. The arity check is also what rejects a cursor issued by the superseded
 * `created_at DESC` ordering: it decodes cleanly and carries one value.
 */
function readCursor(value: string | undefined): TemplateCursor | null {
  if (value === undefined) {
    return null;
  }

  const cursor: KeysetCursor | null = decodeKeysetCursor(value);
  const [name, language, ...rest] = cursor?.sortValues ?? [];

  if (cursor === null || name === undefined || language === undefined || rest.length > 0) {
    throw new InvalidCursorError();
  }

  return { name, language, id: cursor.id };
}

/**
 * "Strictly after the cursor row in `(name ASC, language ASC, id ASC)` order",
 * in the shape 0002 rules for a resume predicate: an inclusive bound on the
 * leading column — `name >= $1`, written where the query is built — minus the
 * part of that name's tie group this caller has already been given.
 *
 * The obvious translation is the nested disjunction
 * `name > $1 OR (name = $1 AND (language > $2 OR (language = $2 AND id > $3)))`.
 * It returns the same rows and is the wrong shape: a planner cannot turn a
 * nested OR into one index start condition, so it scans the range from the
 * beginning and filters — the `OFFSET` cost profile keyset pagination exists to
 * avoid. The bound below is a start condition, and the `NOT` discards only the
 * rows sharing the cursor's name, of which a template list holds a handful.
 */
function alreadyReturned(cursor: TemplateCursor): Prisma.MessageTemplateWhereInput {
  return {
    name: cursor.name,
    OR: [
      { language: { lt: cursor.language } },
      { language: cursor.language, id: { lte: cursor.id } },
    ],
  };
}
