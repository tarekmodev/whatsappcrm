import { Inject, Injectable } from '@nestjs/common';
import type {
  ContactCreateInput,
  ContactListQuery,
  ContactResponse,
  ContactUpdateInput,
  CursorPage,
  CustomFieldValues,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { assertTagsExist } from '../tags/tag-references';
import { ContactNotFoundError, ContactPhoneTakenError } from './contacts.errors';
import {
  CONTACT_PROJECTION,
  toContactResponse,
  toCustomFieldValues,
  type ContactRow,
} from './contact.mapper';
import { readCustomFieldDefinitions } from './custom-field-definitions';
import { mergeCustomFieldValues } from './custom-field-values';

/**
 * The tenant's contacts (TAR-33, the four routes in 0002's endpoint table).
 *
 * Everything runs on `TenantPrisma`, so every statement carries the
 * `app.tenant_id` GUC and is filtered by TAR-48's row-level security. The
 * service takes no tenant id from a caller — there is no parameter for one —
 * which is what makes "no cross-tenant read or write under any role" a property
 * of the wiring rather than of remembering to add a filter.
 *
 * A contact is tenant data every role may see: `contact:read` and
 * `contact:write` are both granted to `agent`, and the assignee-scoped
 * visibility predicate that narrows conversations and tickets does not apply
 * here — an agent picking up a thread has to be able to read the customer on the
 * other end of it.
 *
 * Two invariants live here rather than in the schema:
 *
 *   * **A tag belongs to this tenant.** The composite foreign key
 *     `(tenant_id, tag_id)` is what actually refuses a cross-tenant pairing —
 *     RLS cannot, because the join row carries our own `tenant_id`. Checking
 *     first turns a 500 from a constraint into a `validation_failed` naming the
 *     ids.
 *   * **A custom field value is legal for its definition.** Validated against
 *     the tenant's definitions read inside the same transaction, so a definition
 *     cannot be deleted between the check and the write.
 */
@Injectable()
export class ContactsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The contact directory, newest first.
   *
   * Keyset paginated on `id` descending. Ids are UUIDv7 and therefore already in
   * creation order, so one column does the work of `(created_at, id)` and the
   * scan is served by the `(tenant_id, id)` unique index — the same shape the
   * people list uses, and the reason neither needs a `count(*)` to answer "is
   * there another page".
   */
  async list(query: ContactListQuery): Promise<CursorPage<ContactResponse>> {
    const rows = await this.prisma.contact.findMany({
      where: {
        // An `EXISTS` over `contact_tags`, served by its `(tenant_id, tag_id)`
        // index — not a join that could multiply the contact rows.
        ...(query.tagId === undefined ? {} : { tags: { some: { tagId: query.tagId } } }),
        ...(query.q === undefined ? {} : searchFilter(query.q)),
        ...(query.cursor === undefined ? {} : { id: { lt: query.cursor } }),
      },
      select: CONTACT_PROJECTION,
      orderBy: { id: 'desc' },
      // One more than the page, so "is there another page" costs a row rather
      // than a `count(*)` over the whole filtered set on every request.
      take: query.limit + 1,
    });

    return toPage(rows, query.limit);
  }

  async get(contactId: string): Promise<ContactResponse> {
    const row = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: CONTACT_PROJECTION,
    });

    if (row === null) {
      throw new ContactNotFoundError(contactId);
    }

    return toContactResponse(row);
  }

  async create(input: ContactCreateInput): Promise<ContactResponse> {
    const tenantId = this.tenantContext.requireTenantId();

    return await this.prisma.$tenantTransaction(async (tx) => {
      await assertTagsExist(tx, tenantId, input.tagIds);

      // A create has nothing stored to merge into, so the same merge runs
      // against an empty map — which is what validates every key and value, and
      // is why an unknown key is refused here exactly as it is on update.
      const customFields = await this.resolveCustomFields(tx, {}, input.customFields);

      const created = await tx.contact
        .create({
          data: {
            tenantId,
            phoneE164: input.phone,
            displayName: input.displayName,
            email: input.email ?? null,
            customFields,
          },
          select: { id: true },
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? new ContactPhoneTakenError(input.phone) : error;
        });

      // Written separately rather than as a nested `create`: `contact_tags`
      // reaches its parents through the composite keys `(tenant_id, contact_id)`
      // and `(tenant_id, tag_id)`, so `tenant_id` is a relation scalar Prisma
      // will not accept inside a nested write — and it is not optional, because
      // it is half of what makes the tenant boundary hold.
      if (input.tagIds.length > 0) {
        await tx.contactTag.createMany({
          data: input.tagIds.map((tagId) => ({ tenantId, contactId: created.id, tagId })),
        });
      }

      return toContactResponse(await readContact(tx, created.id));
    });
  }

  /**
   * Partial update. `phone` is absent from the schema — it is the identity key,
   * and merging two contacts is a separate operation.
   *
   * `tagIds` **replaces** the contact's tags, which is what makes this the one
   * route that assigns and removes them: the console sends the set it wants, and
   * the delta is computed here. `customFields` **merges**, per amendment 10.
   * The two differ because a tag list is a small set an agent sees whole on the
   * screen they are editing, while a custom-field map is rendered from a
   * definition list a form may only have loaded part of.
   *
   * Both of those are read-modify-write, so the row lock below is what makes
   * them correct rather than merely intended — see `lockContact`.
   */
  async update(contactId: string, input: ContactUpdateInput): Promise<ContactResponse> {
    const tenantId = this.tenantContext.requireTenantId();

    return await this.prisma.$tenantTransaction(async (tx) => {
      await lockContact(tx, tenantId, contactId);

      const before = await tx.contact.findUnique({
        where: { id: contactId },
        select: { id: true, customFields: true, tags: { select: { tagId: true } } },
      });

      if (before === null) {
        throw new ContactNotFoundError(contactId);
      }

      if (input.tagIds !== undefined) {
        await assertTagsExist(tx, tenantId, input.tagIds);
      }

      const customFields = await this.resolveCustomFields(
        tx,
        toCustomFieldValues(before.customFields),
        input.customFields,
      );

      await tx.contact.update({
        where: { id: contactId },
        data: {
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.email === undefined ? {} : { email: input.email }),
          ...(input.customFields === undefined ? {} : { customFields }),
        },
        select: { id: true },
      });

      if (input.tagIds !== undefined) {
        await replaceTags(tx, tenantId, contactId, before.tags, input.tagIds);
      }

      return toContactResponse(await readContact(tx, contactId));
    });
  }

  /**
   * The stored map with the write merged in, or the stored map untouched when
   * the request carries no `customFields` at all.
   *
   * The definitions are read inside the caller's transaction rather than through
   * a service, so a field cannot be deleted between validating a value against
   * it and storing that value.
   */
  private async resolveCustomFields(
    tx: Prisma.TransactionClient,
    stored: CustomFieldValues,
    incoming: CustomFieldValues | undefined,
  ): Promise<CustomFieldValues> {
    if (incoming === undefined) {
      return stored;
    }

    return mergeCustomFieldValues(stored, incoming, await readCustomFieldDefinitions(tx));
  }
}

/**
 * A single `q` matched against name, phone and email, as the contract publishes
 * it — a structured filter DSL is deliberately deferred.
 *
 * `email` is `citext`, so it is already case-insensitive at the column;
 * `display_name` is plain text and needs the mode. Neither is index-backed: this
 * is a substring search over the tenant's contacts, and the tenant predicate is
 * what bounds it. A trigram index is the answer if a tenant's directory grows
 * past what a scan can serve, and it is a change to this one function.
 */
function searchFilter(q: string): Prisma.ContactWhereInput {
  return {
    OR: [
      { displayName: { contains: q, mode: 'insensitive' } },
      { phoneE164: { contains: q } },
      { email: { contains: q } },
    ],
  };
}

/**
 * Takes the contact's row lock **before** anything in the transaction reads it,
 * so a second writer blocks before its own read rather than in the middle of its
 * read-modify-write.
 *
 * `update` computes both of its writes in JavaScript from a row it read earlier
 * in the same transaction — the custom-field map through
 * `mergeCustomFieldValues`, the tag delta through `replaceTags`. Under
 * `READ COMMITTED` a read takes a fresh snapshot per statement and takes no
 * lock, so without this two `PATCH`es to *different* custom-field keys both read
 * the same stored map, the second one's `UPDATE` waits on the first one's row
 * lock, and then overwrites it with a map computed before the first write
 * existed. Both answer `200` and one key is gone — the same silent data loss the
 * merge exists to prevent, arriving by the other route.
 *
 * Locking first is what closes it: the second transaction waits here, and every
 * statement it runs afterwards is a new snapshot taken once the first has
 * committed, so it merges into the map the first one actually wrote.
 *
 * It also orders this write against `CustomFieldsService.delete`'s value strip —
 * but only **for a contact that already holds the deleted key**. `stripValues`
 * filters on `jsonb_exists(custom_fields, key)`, so a contact with no value under
 * that key is never matched and never locked, and a `PATCH` writing that key can
 * still interleave with the definition delete and leave an orphaned value behind.
 * That race is older than this lock and is not closed here; closing it needs
 * either an unconditional lock in the strip or `FOR SHARE` on the definition rows
 * read by `readCustomFieldDefinitions`.
 *
 * `FOR NO KEY UPDATE` rather than `FOR UPDATE`, which is the weakest mode that
 * still does the job. It self-conflicts, so two `update` transactions exclude
 * each other, and it conflicts with the implicit lock that `tx.contact.update`
 * and `stripValues` take — every writer that matters. What it deliberately does
 * *not* block is `FOR KEY SHARE`, which Postgres takes on this row whenever a
 * `conversations` or `tickets` row referencing it is inserted: `FOR UPDATE` would
 * make an inbound WhatsApp message wait on any in-flight console `PATCH` of that
 * contact, coupling the ingest hot path to an editor's save for no isolation this
 * write actually needs.
 *
 * One extra round trip per `PATCH`, served by the primary key.
 *
 * An id that names no contact in this tenant locks nothing and returns nothing —
 * RLS and the explicit `tenant_id` predicate both see to that — and the caller's
 * own `findUnique` is what turns that into `ContactNotFoundError`, so there is
 * no second not-found path to keep in step.
 */
async function lockContact(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT id
    FROM contacts
    WHERE tenant_id = ${tenantId}::uuid
      AND id = ${contactId}::uuid
    FOR NO KEY UPDATE
  `;
}

/** Re-read through the response projection, so a write answers exactly what a read would. */
async function readContact(tx: Prisma.TransactionClient, contactId: string): Promise<ContactRow> {
  return await tx.contact.findUniqueOrThrow({
    where: { id: contactId },
    select: CONTACT_PROJECTION,
  });
}

async function replaceTags(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactId: string,
  current: readonly { tagId: string }[],
  wantedIds: readonly string[],
): Promise<void> {
  const held = new Set(current.map((row) => row.tagId));
  const wanted = new Set(wantedIds);

  const added = [...wanted].filter((tagId) => !held.has(tagId));
  const removed = [...held].filter((tagId) => !wanted.has(tagId));

  if (removed.length > 0) {
    await tx.contactTag.deleteMany({ where: { contactId, tagId: { in: removed } } });
  }

  if (added.length > 0) {
    await tx.contactTag.createMany({
      data: added.map((tagId) => ({ tenantId, contactId, tagId })),
    });
  }
}

function toPage(rows: readonly ContactRow[], limit: number): CursorPage<ContactResponse> {
  const items = rows.slice(0, limit);

  return {
    items: items.map(toContactResponse),
    nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
