import { Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { describeTemplateComponents } from './message-template-components';
import {
  alreadyReturned,
  encodeMessageTemplateCursor,
  readMessageTemplateCursor,
} from './message-template-cursor';
import { messageTemplateSendBlockers } from './message-template-sendability';
import { MESSAGE_TEMPLATE_PROJECTION, type ListedTemplate } from './message-template.projection';

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
  items: ListedTemplate[];
  nextCursor: string | null;
}

/** What a send names a template by: the number it goes out on, and Meta's own key. */
export interface FindApprovedTemplateQuery {
  /** The tenant in scope. RLS filters on it too; the unique index needs it addressable. */
  tenantId: string;
  /** `whatsapp_accounts.id` — the number the conversation belongs to. */
  whatsappAccountId: string;
  name: string;
  /** Meta's language tag, exactly as `MessageTemplateResponse.language` published it. */
  language: string;
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
    const cursor = readMessageTemplateCursor(query.cursor);
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
      select: MESSAGE_TEMPLATE_PROJECTION,
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
        // The same predicate the administration surface publishes as
        // `sendBlockers`, so "dropped from the picker" and "reported as blocked"
        // cannot drift apart. `status` is already `approved` for every row here,
        // which leaves the button rule as the only one that can fire — the SQL
        // filter above is that half of the predicate applied earlier, where the
        // index can serve it.
        .filter(
          ({ row, summary }) => messageTemplateSendBlockers(row.status, summary).length === 0,
        ),
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodeMessageTemplateCursor(last) : null,
    };
  }

  /**
   * One approved template, by the name and language a send names it with.
   *
   * The send path's pre-check (TAR-68). Meta validates the same things and
   * answers with an opaque provider error — a parameter index at best — which
   * an agent cannot act on and which arrives *after* the message row has been
   * created, so the composer would show a reply that silently failed. Reading
   * the row first is what turns that into `whatsapp_template_invalid` while the
   * composer is still open.
   *
   * `null` for a template that does not exist, is not approved, or belongs to
   * another WABA — the three are indistinguishable to the caller on purpose,
   * being the same "you cannot send this" and none of them worth confirming the
   * existence of somebody else's template for.
   *
   * The `approved` filter is the same fixed one `list` applies and for the same
   * reason: Meta refuses a send on a `pending`, `rejected`, `paused` or
   * `disabled` template, so there is no request that can reach an unapproved one
   * through this service.
   */
  async findApprovedForNumber(query: FindApprovedTemplateQuery): Promise<ListedTemplate | null> {
    const whatsappBusinessAccountId = await this.businessAccountIdForNumber(
      query.whatsappAccountId,
    );

    const row = await this.prisma.messageTemplate.findUnique({
      where: {
        tenantId_whatsappBusinessAccountId_name_language: {
          // Supplied because the unique index leads with it; RLS supplies the
          // same equality independently, so this narrows nothing it does not
          // already narrow — it is what makes the composite key addressable.
          tenantId: query.tenantId,
          whatsappBusinessAccountId,
          name: query.name,
          language: query.language,
        },
        status: 'approved',
      },
      select: MESSAGE_TEMPLATE_PROJECTION,
    });

    return row === null ? null : { row, summary: describeTemplateComponents(row.components) };
  }

  /**
   * The number, when one is named, otherwise whatever WABA the caller asked for.
   * The contract rejects both together, so there is no precedence to decide here.
   */
  private async resolveBusinessAccountId(
    query: ListMessageTemplatesQuery,
  ): Promise<string | undefined> {
    return query.whatsappAccountId === undefined
      ? query.whatsappBusinessAccountId
      : await this.businessAccountIdForNumber(query.whatsappAccountId);
  }

  /**
   * The WABA behind one connected number.
   *
   * Throws rather than returning `null` for a miss: both callers hold an id they
   * believe in — the composer read it off a conversation, the send path off the
   * conversation it is replying to — so "no such number" is bad input or a
   * broken reference, never an empty result. A number belonging to another
   * tenant arrives here as the same miss, because RLS hides it.
   */
  private async businessAccountIdForNumber(whatsappAccountId: string): Promise<string> {
    const account = await this.prisma.whatsappAccount.findUnique({
      where: { id: whatsappAccountId },
      select: { whatsappBusinessAccountId: true },
    });

    if (account === null) {
      throw new UnknownWhatsAppAccountError();
    }

    return account.whatsappBusinessAccountId;
  }
}
