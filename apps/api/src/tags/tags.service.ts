import { Inject, Injectable } from '@nestjs/common';
import type { CursorPage, Tag, TagCreateInput, TagListQuery } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { toTag, TAG_PROJECTION, type TagRow } from './tag.mapper';
import { TagNameTakenError } from './tags.errors';

/**
 * The tenant's contact taxonomy (TAR-33; the two routes 0002 published under
 * TAR-392 and this story absorbs unchanged).
 *
 * Everything runs on `TenantPrisma`, so every statement carries the
 * `app.tenant_id` GUC and is filtered by TAR-48's row-level security. The
 * service takes no tenant id from a caller — there is no parameter for one —
 * which is what makes "no cross-tenant read or write under any role" a property
 * of the wiring rather than of remembering to add a filter.
 *
 * Tags are tenant *configuration* rather than assignable records: everyone
 * holding `contact:read` sees all of them, and the visibility predicate that
 * scopes conversations and tickets to their assignee does not apply. Isolation
 * is the tenant boundary alone.
 *
 * `contact:read` to list and `contact:write` to create, as 0002 publishes. The
 * write half is deliberately *not* `tenant:settings`: a tag is a label an agent
 * puts on a customer while talking to them, unlike a custom field definition,
 * which changes the shape of every contact record in the tenant.
 */
@Injectable()
export class TagsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Keyset paginated on `id` ascending, like the team list and unlike the people
   * list: tags are a small, stable set that a picker and a filter dropdown
   * render whole, and newest-first would reshuffle the list every time an agent
   * coins a label mid-conversation.
   *
   * Served by `tags (tenant_id, id)`, which is already there as the composite
   * key `contact_tags` reaches its parent through.
   */
  async list(query: TagListQuery): Promise<CursorPage<Tag>> {
    const rows = await this.prisma.tag.findMany({
      where: {
        // `mode: 'insensitive'`, unlike the team list: `teams.name` is `citext`
        // and `tags.name` is plain `text`, so the case-insensitivity a type-ahead
        // needs has to come from the query here rather than from the column.
        ...(query.q === undefined ? {} : { name: { contains: query.q, mode: 'insensitive' } }),
        ...(query.cursor === undefined ? {} : { id: { gt: query.cursor } }),
      },
      select: TAG_PROJECTION,
      orderBy: { id: 'asc' },
      // One more than the page, so "is there another page" costs a row rather
      // than a `count(*)` over the whole filtered set on every request.
      take: query.limit + 1,
    });

    return toPage(rows, query.limit);
  }

  async create(input: TagCreateInput): Promise<Tag> {
    const tenantId = this.tenantContext.requireTenantId();

    const row = await this.prisma.tag
      .create({
        data: { tenantId, name: input.name, color: input.color ?? null },
        select: TAG_PROJECTION,
      })
      .catch((error: unknown) => {
        throw isUniqueViolation(error) ? new TagNameTakenError(input.name) : error;
      });

    return toTag(row);
  }
}

function toPage(rows: readonly TagRow[], limit: number): CursorPage<Tag> {
  const items = rows.slice(0, limit);

  return {
    items: items.map(toTag),
    nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
