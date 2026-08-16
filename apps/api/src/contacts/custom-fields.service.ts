import { Inject, Injectable } from '@nestjs/common';
import {
  CUSTOM_FIELD_LIMITS,
  RoutingConditionListSchema,
  type CustomFieldDefinition,
  type CustomFieldDefinitionCreateInput,
  type CustomFieldDefinitionListResponse,
  type CustomFieldDefinitionReorderInput,
  type CustomFieldDefinitionUpdateInput,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import {
  CustomFieldInUseByRulesError,
  CustomFieldKeyTakenError,
  CustomFieldNotFoundError,
  CustomFieldOptionsMismatchError,
  CustomFieldSetChangedError,
  TooManyCustomFieldsError,
} from './contacts.errors';
import { readCustomFieldDefinitions } from './custom-field-definitions';
import {
  CUSTOM_FIELD_PROJECTION,
  DISPLAY_ORDER,
  toCustomFieldDefinition,
  type CustomFieldDefRow,
} from './custom-field.mapper';

/**
 * The tenant's contact schema (TAR-33, 0002 amendment 10): what fields a contact
 * has, what type each one is, and in what order the profile renders them.
 *
 * Everything runs on `TenantPrisma`, so every statement carries the
 * `app.tenant_id` GUC and is filtered by TAR-48's row-level security. The
 * service takes no tenant id from a caller — there is no parameter for one.
 *
 * `tenant:settings` to mutate and `contact:read` to list, which the controller
 * declares. That split *is* this story's first acceptance criterion: every agent
 * holds `contact:write`, so carrying the write half on it would let any agent
 * redefine the tenant's contact record.
 *
 * Three invariants live here rather than in the schema, because the schema
 * cannot express them:
 *
 *   * **`key` and `type` are immutable.** Enforced by
 *     `CustomFieldDefinitionUpdateInputSchema`, which does not accept either —
 *     so there is nothing to refuse here, and that is the point. Renaming a key
 *     orphans every stored value and silently stops every routing rule naming it
 *     from ever matching.
 *   * **`options` is non-empty exactly when the type is `select`.** The update
 *     schema sees `options` without seeing `type`, so only this service knows
 *     the stored type to check it against.
 *   * **Delete strips the values.** The definition row and every contact's value
 *     under that key go in one transaction, so an admin who deletes
 *     `national_id` and later re-creates the same key does not get every old
 *     value back on a screen giving no hint they were ever there.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The whole vocabulary, in display order.
   *
   * Unpaginated, and `nextCursor` is fixed at `null` (amendment 10): the routing-
   * rule dropdown and the profile form both need the set whole, and
   * `definitionsPerTenant` is enforced on create, so a bounded response is a
   * promise the server can keep. The shape stays `CursorPage`'s so a generic
   * list client works against it unchanged.
   */
  async list(): Promise<CustomFieldDefinitionListResponse> {
    const rows = await this.prisma.customFieldDef.findMany({
      select: CUSTOM_FIELD_PROJECTION,
      orderBy: DISPLAY_ORDER,
      // One over the cap, so a set that somehow exceeded it is visible as a
      // fault rather than silently truncated to look complete.
      take: CUSTOM_FIELD_LIMITS.definitionsPerTenant + 1,
    });

    return { items: rows.map(toCustomFieldDefinition), nextCursor: null };
  }

  async create(input: CustomFieldDefinitionCreateInput): Promise<CustomFieldDefinition> {
    const tenantId = this.tenantContext.requireTenantId();

    return await this.prisma.$tenantTransaction(async (tx) => {
      await assertUnderFieldCap(tx);

      const row = await tx.customFieldDef
        .create({
          data: {
            tenantId,
            key: input.key,
            label: input.label,
            type: input.type,
            options: input.options,
            // Server-side, never client-supplied: two admins creating a field at
            // the same moment must not both land on `0`, and `PATCH` does not
            // accept `position` at all, so `reorder` is the one way to change it.
            position: await nextPosition(tx),
          },
          select: CUSTOM_FIELD_PROJECTION,
        })
        .catch((error: unknown) => {
          throw isUniqueViolation(error) ? new CustomFieldKeyTakenError(input.key) : error;
        });

      await this.recordChange(tx, AUDIT_ACTIONS.customFieldCreated, row);

      return toCustomFieldDefinition(row);
    });
  }

  /**
   * `label` and `options`, and nothing else — the schema is what refuses `key`
   * and `type`, and this checks the one pairing it cannot see.
   */
  async update(
    customFieldId: string,
    input: CustomFieldDefinitionUpdateInput,
  ): Promise<CustomFieldDefinition> {
    return await this.prisma.$tenantTransaction(async (tx) => {
      const before = await tx.customFieldDef.findUnique({
        where: { id: customFieldId },
        select: { id: true, type: true },
      });

      if (before === null) {
        throw new CustomFieldNotFoundError(customFieldId);
      }

      // `options` is non-empty exactly when the type is `select`, in both
      // directions — the same rule `CustomFieldDefinitionSchema` states about a
      // whole definition, checked here because the update schema sees `options`
      // without seeing `type`.
      if (input.options !== undefined && (before.type === 'select') !== input.options.length > 0) {
        throw new CustomFieldOptionsMismatchError(before.type);
      }

      const row = await tx.customFieldDef.update({
        where: { id: customFieldId },
        data: {
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.options === undefined ? {} : { options: input.options }),
        },
        select: CUSTOM_FIELD_PROJECTION,
      });

      await this.recordChange(tx, AUDIT_ACTIONS.customFieldUpdated, row);

      return toCustomFieldDefinition(row);
    });
  }

  /**
   * The definition row **and** every contact's value under that key, in one
   * transaction (amendment 10).
   *
   * `not_found` for an unknown id rather than the idempotent `204`
   * `AssignmentRulesService.delete` answers, and the difference is deliberate:
   * this call has a second effect, and reporting success for an id that was
   * never examined would tell an admin their tenant's values under that key are
   * gone when nothing looked.
   *
   * The strip is a write proportional to the tenant's contact count, with no
   * index to help it — the amendment names that as the accepted cost of a rare,
   * admin-triggered action, and names the breaking point too: when it exceeds
   * the request timeout the transaction rolls back whole and nothing is
   * half-done, and the fix at that point is to move the strip to a job.
   */
  async delete(customFieldId: string): Promise<void> {
    const tenantId = this.tenantContext.requireTenantId();

    await this.prisma.$tenantTransaction(async (tx) => {
      const row = await tx.customFieldDef.findUnique({
        where: { id: customFieldId },
        select: CUSTOM_FIELD_PROJECTION,
      });

      if (row === null) {
        throw new CustomFieldNotFoundError(customFieldId);
      }

      const rules = await rulesNaming(tx, row.key);

      if (rules.length > 0) {
        throw new CustomFieldInUseByRulesError(row.key, rules);
      }

      await tx.customFieldDef.delete({ where: { id: customFieldId } });
      await stripValues(tx, tenantId, row.key);
      await this.recordChange(tx, AUDIT_ACTIONS.customFieldDeleted, row);
    });
  }

  /**
   * Rewrites `position` to the array index, in one transaction.
   *
   * `customFieldIds` is the tenant's **complete** set rather than a delta, on
   * `AssignmentRuleReorderInputSchema`'s reasoning — and here it also gives
   * optimistic concurrency for free: a submitted set that is not exactly the
   * current one means another admin added or deleted a field since this client
   * loaded, and the answer is `conflict` rather than a silent partial reorder.
   */
  async reorder(
    input: CustomFieldDefinitionReorderInput,
  ): Promise<CustomFieldDefinitionListResponse> {
    return await this.prisma.$tenantTransaction(async (tx) => {
      const held = await tx.customFieldDef.findMany({ select: { id: true } });

      if (
        !isSameSet(
          input.customFieldIds,
          held.map((definition) => definition.id),
        )
      ) {
        throw new CustomFieldSetChangedError();
      }

      // One statement per definition, bounded by `definitionsPerTenant`.
      // `updateMany` cannot express "a different value per row", and the
      // alternative — a raw `UPDATE … FROM (VALUES …)` — would trade a readable
      // statement for a saving on a call an admin makes by hand.
      for (const [position, id] of input.customFieldIds.entries()) {
        await tx.customFieldDef.updateMany({ where: { id }, data: { position } });
      }

      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.customFieldReordered,
        targetType: 'custom_field',
        // The operation is on the list, not on one field. `targetId` is not
        // nullable, so it names the field that now renders first.
        targetId: input.customFieldIds[0] ?? EMPTY_FIELD_SET_TARGET,
        metadata: { customFieldIds: [...input.customFieldIds] },
      });

      return { items: await readCustomFieldDefinitions(tx), nextCursor: null };
    });
  }

  private async recordChange(
    tx: Prisma.TransactionClient,
    action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
    row: CustomFieldDefRow,
  ): Promise<void> {
    await this.audit.record(tx, {
      action,
      targetType: 'custom_field',
      targetId: row.id,
      // The key, the label and the type — the shape of the field, never a value
      // any contact holds under it. This table is exported for compliance review
      // rather than being a place to discover a customer's data.
      metadata: { key: row.key, label: row.label, type: row.type },
    });
  }
}

/**
 * A reorder of an empty set is a no-op that still writes an audit row, and
 * `audit_logs.target_id` is not nullable. The all-zero UUID says "the list, not
 * a field" without inventing a nullable column for a case that happens when a
 * console posts an empty array.
 */
const EMPTY_FIELD_SET_TARGET = '00000000-0000-0000-0000-000000000000';

async function nextPosition(tx: Prisma.TransactionClient): Promise<number> {
  const { _max } = await tx.customFieldDef.aggregate({ _max: { position: true } });

  return _max.position === null ? 0 : _max.position + 1;
}

/**
 * The cap is checked, then the row is written, so two creates racing at the
 * boundary can both pass and leave the tenant one field over. Accepted rather
 * than locked, on `assertUnderRuleCap`'s reasoning: the consequence is a 51st
 * definition on a bound that exists to keep the list unpaginated, not a
 * correctness failure, and an advisory lock on every create would be a heavier
 * mechanism than the risk deserves.
 */
async function assertUnderFieldCap(tx: Prisma.TransactionClient): Promise<void> {
  const held = await tx.customFieldDef.count();

  if (held >= CUSTOM_FIELD_LIMITS.definitionsPerTenant) {
    throw new TooManyCustomFieldsError();
  }
}

/**
 * The routing rules whose `contact_attribute` conditions name `key`.
 *
 * A bounded read of the tenant's rules filtered in JavaScript rather than a
 * JSONB containment query: `conditions` is an array of objects whose remaining
 * fields vary, so `array_contains` cannot express "any element with this `type`
 * and this `key`" without also fixing `operator` and `value`. The set is capped
 * at `rulesPerTenant`, and this runs once per delete — an action an admin takes
 * by hand.
 *
 * A stored condition list that no longer parses is skipped rather than raised.
 * The question being asked is "would deleting this field break a rule", and a
 * rule that is already unreadable is not made worse by the answer.
 */
async function rulesNaming(
  tx: Prisma.TransactionClient,
  key: string,
): Promise<{ id: string; name: string }[]> {
  const rules = await tx.assignmentRule.findMany({
    select: { id: true, name: true, conditions: true },
  });

  return rules
    .filter((rule) => {
      const conditions = RoutingConditionListSchema.safeParse(rule.conditions);

      return (
        conditions.success &&
        conditions.data.some(
          (condition) => condition.type === 'contact_attribute' && condition.key === key,
        )
      );
    })
    .map((rule) => ({ id: rule.id, name: rule.name }));
}

/**
 * `UPDATE contacts SET custom_fields = custom_fields - $key` for the tenant, as
 * amendment 10 specifies it, with two guards the amendment's SQL leaves implicit.
 *
 * `jsonb_exists(…)` rather than the `?` operator: they are the same operator,
 * and the function spelling cannot be mistaken for a placeholder by any driver
 * in the path. `::text` on the key because `jsonb - integer` removes an *array
 * element*, and the cast is what pins the intended overload.
 *
 * `jsonb_typeof(...) = 'object'` is the guard that matters. `custom_fields`
 * accepts any JSONB today: on an array `- 'key'` silently removes a matching
 * element instead of failing, and on a scalar it raises and aborts the whole
 * delete — so one contact row written by hand or by an old import would turn an
 * admin's settings action into a 500. Neither shape is a value this API can
 * write, and neither is readable through `toCustomFieldValues`, so skipping them
 * strips nothing a client could ever have seen.
 *
 * `updated_at` is set explicitly: Prisma's `@updatedAt` is applied client-side
 * and a raw statement does not go through it, and a contact whose values changed
 * without its timestamp moving is a contact a caching client keeps stale.
 */
async function stripValues(
  tx: Prisma.TransactionClient,
  tenantId: string,
  key: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE contacts
       SET custom_fields = custom_fields - ${key}::text,
           updated_at = now()
     WHERE tenant_id = ${tenantId}::uuid
       AND jsonb_typeof(custom_fields) = 'object'
       AND jsonb_exists(custom_fields, ${key})
  `;
}

/**
 * Same members, same count — so a `customFieldIds` that repeats one id and omits
 * another is refused rather than reordering half the list. The schema does not
 * catch that on its own: it caps the array's length and does not assert
 * uniqueness.
 */
function isSameSet(submitted: readonly string[], held: readonly string[]): boolean {
  const unique = new Set(submitted);

  return (
    unique.size === submitted.length &&
    submitted.length === held.length &&
    held.every((id) => unique.has(id))
  );
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
