import { Inject, Injectable } from '@nestjs/common';
import type { MessageTemplateStatus } from '@whatsappcrm/contracts';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { describeTemplateComponents } from './message-template-components';
import {
  alreadyReturned,
  encodeMessageTemplateCursor,
  readMessageTemplateCursor,
} from './message-template-cursor';
import { MESSAGE_TEMPLATE_PROJECTION, type ListedTemplate } from './message-template.projection';

export interface ListAllMessageTemplatesQuery {
  limit: number;
  cursor?: string;
  whatsappBusinessAccountId?: string;
  /** Meta's approval status. Narrows the page; it can never widen it. */
  status?: MessageTemplateStatus;
  /** Name prefix. */
  q?: string;
}

export interface MessageTemplateAdministrationPage {
  items: ListedTemplate[];
  nextCursor: string | null;
}

/**
 * Reads every template a tenant holds, whatever Meta thinks of it (TAR-91; shape
 * ruled in `docs/architecture/0002-architecture-and-api-contract.md`,
 * amendment 8).
 *
 * ## Why this is a second service and not a parameter on the first
 *
 * `MessageTemplateQueryService` states, as the property its callers depend on,
 * that no request reaching it can produce an unapproved template: `list` fixes
 * `status: 'approved'` in the `where`, and `findApprovedForNumber` — the send
 * path's pre-check — fixes it again. A flag that relaxed the filter would put
 * "show the rejected ones" one boolean away from the code that decides what may
 * be sent, and the send path would be sharing a class with the one caller that
 * wants the opposite default. Two services, two permissions, and the invariant
 * over there stays literally true.
 *
 * What they do share is everything that has to agree: the projection, the
 * ordering and its cursor, the component derivation, and the exclusion predicate
 * (`message-template-sendability.ts`). The duplication that would matter is
 * behavioural, and none of it is duplicated.
 *
 * ## No status filter in the `where` unless the caller asked for one
 *
 * That is the whole point of the surface: amendment 1 accepts an approved-only
 * picker and a button exclusion on the promise that both are visible here. A
 * default applied quietly would be the same gap one layer down.
 *
 * ## Isolation
 *
 * There is no `tenantId` in the `where`, and that is deliberate rather than an
 * oversight: `TenantPrisma` runs every statement behind
 * `set_config('app.tenant_id', …)` and TAR-48's `tenant_isolation` policy adds
 * the equality itself. A `whatsappBusinessAccountId` belonging to another tenant
 * therefore narrows this page to nothing rather than widening it to a
 * neighbour's templates — the filter can only ever intersect with what RLS
 * already allows. Widening the *status* filter does not widen the *tenant*
 * scope, which is why this surface needs no isolation mechanism of its own.
 *
 * ## Query cost
 *
 * One statement per page. `take: limit + 1` decides whether there is another
 * page without a `count(*)`. Unfiltered by status, the page reads
 * `message_templates (tenant_id, name, language, id)` — added by
 * `20260813120000_message_template_administration_index` — which covers the RLS
 * equality and all three sort keys, so it is an index range scan with no sort
 * node; the composer's index cannot serve it, because `status` sits second there
 * and this query does not constrain it. With `status` supplied the planner has
 * both indexes available and either serves the query ordered. `q` extends the
 * range under the C collation this repo provisions. The WABA equality is a
 * heap-side recheck rather than a third index: it narrows an already-bounded
 * page, and an index on the same prefix would cost write throughput on every
 * template sync for no read it uniquely serves.
 *
 * Unlike the composer's list this page is never shortened after the read — every
 * row it fetched is a row it returns — so `limit` items means `limit` items.
 */
@Injectable()
export class MessageTemplateAdministrationService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  async list(query: ListAllMessageTemplatesQuery): Promise<MessageTemplateAdministrationPage> {
    const cursor = readMessageTemplateCursor(query.cursor);

    const rows = await this.prisma.messageTemplate.findMany({
      where: {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.whatsappBusinessAccountId === undefined
          ? {}
          : { whatsappBusinessAccountId: query.whatsappBusinessAccountId }),
        // One `name` filter, not two: the prefix and the cursor's lower bound
        // both constrain the same column, and a second `name` key would silently
        // replace the first.
        name: {
          ...(query.q === undefined ? {} : { startsWith: query.q }),
          ...(cursor === null ? {} : { gte: cursor.name }),
        },
        ...(cursor === null ? {} : { NOT: alreadyReturned(cursor) }),
      },
      // Amendment 1's ordering, unchanged, so the two template lists put the
      // same row in the same place. The id is not decoration: `(name, language)`
      // is unique only within a WABA, so a page spanning two of them can hold
      // the same pair twice, and one row would be skipped at a page boundary
      // without a total order.
      orderBy: [{ name: 'asc' }, { language: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      select: MESSAGE_TEMPLATE_PROJECTION,
    });

    const window = rows.slice(0, query.limit);
    const last = window.at(-1);

    return {
      items: window.map((row) => ({ row, summary: describeTemplateComponents(row.components) })),
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodeMessageTemplateCursor(last) : null,
    };
  }
}
