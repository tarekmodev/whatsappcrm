import { CustomFieldTypeSchema, type CustomFieldDefinition } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { UnsupportedCustomFieldTypeError } from './contacts.errors';

/**
 * `custom_field_defs` → `CustomFieldDefinition`.
 *
 * Two places the column and the contract disagree, both resolved here so no
 * endpoint can answer differently:
 *
 *   * **`options` is nullable JSONB and the contract publishes an array.** A
 *     definition that is not a `select` has none, and anything in the column that
 *     is not an array of strings is dropped rather than coerced — the alternative
 *     publishes `[object Object]` as a selectable option.
 *   * **The Postgres enum carries six labels and the contract publishes five.**
 *     `multi_select` is refused at the edge by `CustomFieldTypeSchema` (0002
 *     amendment 10) rather than dropped by a migration. Nothing this API writes
 *     can produce one, so a row carrying it was written by hand or by a future
 *     migration, and it raises rather than being silently rendered as `text`:
 *     publishing it as another type would let an agent save a value the routing
 *     engine reads under different rules.
 */

export const CUSTOM_FIELD_PROJECTION = {
  id: true,
  key: true,
  label: true,
  type: true,
  options: true,
  position: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CustomFieldDefSelect;

export type CustomFieldDefRow = Prisma.CustomFieldDefGetPayload<{
  select: typeof CUSTOM_FIELD_PROJECTION;
}>;

/**
 * Display order, everywhere it is read: ascending `position`, ties broken on
 * `id`.
 *
 * The tie-break is load-bearing rather than cosmetic, on the routing engine's
 * reasoning (0007 decision 2): `position` defaults to `0` and carries no unique
 * constraint, so without it two definitions created before the reorder endpoint
 * was ever called have no defined order and the profile form would render them
 * differently between two requests. Ids are UUIDv7, so a tie resolves in
 * creation order.
 */
export const DISPLAY_ORDER = [
  { position: 'asc' },
  { id: 'asc' },
] as const satisfies Prisma.Enumerable<Prisma.CustomFieldDefOrderByWithRelationInput>;

export function toCustomFieldDefinition(row: CustomFieldDefRow): CustomFieldDefinition {
  const type = CustomFieldTypeSchema.safeParse(row.type);

  if (!type.success) {
    throw new UnsupportedCustomFieldTypeError(row.key, row.type);
  }

  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: type.data,
    options: toOptions(row.options),
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toOptions(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((option): option is string => typeof option === 'string')
    : [];
}
