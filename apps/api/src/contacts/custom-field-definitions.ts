import { CUSTOM_FIELD_LIMITS, type CustomFieldDefinition } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import {
  CUSTOM_FIELD_PROJECTION,
  DISPLAY_ORDER,
  toCustomFieldDefinition,
} from './custom-field.mapper';

/**
 * The tenant's whole custom-field vocabulary, in display order.
 *
 * A plain function rather than a method on `CustomFieldsService`, on
 * `tag-references.ts`' reasoning: `ContactsService` needs it *inside* its own
 * write transaction, so that a definition cannot be deleted between validating a
 * value against it and storing that value — and a provider cannot be handed a
 * transaction client.
 *
 * The read is bounded by `definitionsPerTenant + 1` rather than by the cap
 * itself, so a set that somehow exceeded it is visible as a fault instead of
 * being silently truncated to look complete.
 */
export async function readCustomFieldDefinitions(
  tx: Prisma.TransactionClient,
): Promise<CustomFieldDefinition[]> {
  const rows = await tx.customFieldDef.findMany({
    select: CUSTOM_FIELD_PROJECTION,
    orderBy: DISPLAY_ORDER,
    take: CUSTOM_FIELD_LIMITS.definitionsPerTenant + 1,
  });

  return rows.map(toCustomFieldDefinition);
}
