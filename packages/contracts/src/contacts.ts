import { z } from 'zod';
import { HexColorSchema, IdSchema, PhoneE164Schema, TimestampSchema } from './common';
import { CursorPageQuerySchema } from './pagination';

/**
 * CRM core: contacts, tags and custom fields. TAR-33 owns the tag and
 * custom-field editors; TAR-20 creates contacts implicitly from inbound traffic.
 */

export const TagSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(40),
  color: HexColorSchema,
});

// ---------------------------------------------------------------------------
// Custom field definitions — 0002 amendment 10 (TAR-476)
// ---------------------------------------------------------------------------

/**
 * The five types a tenant may define. `custom_field_type` in Postgres carries a
 * sixth, `multi_select`, which this contract deliberately does **not** publish:
 * a value is a single string (`CustomFieldValuesSchema`), and multi-select would
 * need an encoding decision plus "any of" semantics for the routing engine's
 * `equals` / `contains` operators. The enum label stays in the database because
 * dropping it is a migration that buys nothing; this schema is what refuses it.
 */
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'select'] as const;
export const CustomFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES);

/**
 * Bounds three consumers have to agree on — the API enforces them, the field
 * editor renders `maxLength` from them, and the routing-rule dropdown assumes
 * the whole vocabulary fits in one unpaginated read.
 *
 * `definitionsPerTenant` is what makes the definition list a bounded response
 * rather than a page, and it sits under `CursorPageQuerySchema`'s ceiling of 100
 * so the shipped console read (`?limit=100`) can never truncate the vocabulary.
 */
export const CUSTOM_FIELD_LIMITS = {
  definitionsPerTenant: 50,
  keyLength: 40,
  labelLength: 80,
  optionsPerDefinition: 50,
  optionLength: 80,
  /** Cap on a stored value of type `text`. */
  textValueLength: 500,
} as const;

/**
 * Keys that would shadow a built-in contact field on the profile form. Nothing
 * breaks if one is used — the routing engine reads `contacts.custom_fields` and
 * only those (0007) — but a tenant-defined `email` rendered beside the real
 * `email` is a support ticket waiting to happen, and refusing at definition time
 * costs one array.
 */
export const RESERVED_CUSTOM_FIELD_KEYS = [
  'id',
  'phone',
  'email',
  'name',
  'display_name',
  'tags',
  'locale',
] as const;

/**
 * Stable machine key. It is the key inside `contacts.custom_fields`, the key a
 * `contact_attribute` routing condition names, and — per amendment 10 —
 * **immutable after creation**. `label` is the renameable half.
 */
export const CustomFieldKeySchema = z
  .string()
  .min(1)
  .max(CUSTOM_FIELD_LIMITS.keyLength)
  .regex(/^[a-z][a-z0-9_]*$/)
  .refine(
    (key) => !RESERVED_CUSTOM_FIELD_KEYS.some((reserved) => reserved === key),
    'Reserved: this key would shadow a built-in contact field',
  );

export const CustomFieldOptionsSchema = z
  .array(z.string().min(1).max(CUSTOM_FIELD_LIMITS.optionLength))
  .max(CUSTOM_FIELD_LIMITS.optionsPerDefinition)
  .refine((options) => new Set(options).size === options.length, 'Options must be distinct');

/** `options` is non-empty exactly when the type is `select`, in both directions. */
function optionsMatchType(definition: {
  type: (typeof CUSTOM_FIELD_TYPES)[number];
  options: readonly string[];
}): boolean {
  return (definition.type === 'select') === definition.options.length > 0;
}

const OPTIONS_MATCH_TYPE_MESSAGE = '`options` is required for `select` and forbidden otherwise';

export const CustomFieldDefinitionSchema = z
  .object({
    id: IdSchema,
    /** Stable machine key; `label` is what users see and may be renamed freely. */
    key: CustomFieldKeySchema,
    label: z.string().min(1).max(CUSTOM_FIELD_LIMITS.labelLength),
    type: CustomFieldTypeSchema,
    /** Populated only when `type` is `select`. */
    options: CustomFieldOptionsSchema.default([]),
    /**
     * Display order on the contact profile. Assigned server-side on create
     * (`max(position) + 1`) and changed only by the reorder endpoint, so two
     * admins creating a field at the same moment do not both land on `0`.
     */
    position: z.int().min(0),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .refine(optionsMatchType, { message: OPTIONS_MATCH_TYPE_MESSAGE, path: ['options'] });

/**
 * `position` is deliberately absent: order is the reorder endpoint's to set, and
 * a client-supplied position on create is a race between two admins.
 */
export const CustomFieldDefinitionCreateInputSchema = z
  .object({
    key: CustomFieldKeySchema,
    label: z.string().min(1).max(CUSTOM_FIELD_LIMITS.labelLength),
    type: CustomFieldTypeSchema,
    options: CustomFieldOptionsSchema.default([]),
  })
  .refine(optionsMatchType, { message: OPTIONS_MATCH_TYPE_MESSAGE, path: ['options'] });

/**
 * **`key` and `type` are not updatable.** Every value already stored was written
 * under the old key and validated against the old type, and nothing re-validates
 * them: renaming the key orphans every contact's value and silently breaks every
 * routing rule naming it, and changing `text` → `number` leaves agents holding a
 * profile the API will refuse to save back. Both are delete-and-recreate.
 *
 * Removing an option from a `select` is allowed and rewrites no contact: a
 * stored value outside the current options survives untouched until that field
 * is next written, because contact writes validate only the keys they carry.
 */
export const CustomFieldDefinitionUpdateInputSchema = z
  .object({
    label: z.string().min(1).max(CUSTOM_FIELD_LIMITS.labelLength).optional(),
    options: CustomFieldOptionsSchema.optional(),
  })
  .refine(
    (input) => input.label !== undefined || input.options !== undefined,
    'At least one field must be present',
  );

/**
 * The tenant's **complete** definition set, in display order — not a delta. A
 * submitted set that is not exactly the tenant's current set means someone added
 * or deleted a field since this client loaded, and the API answers `conflict`
 * rather than reordering half of it. Amendment 7's `reorder` shape, unchanged.
 */
export const CustomFieldDefinitionReorderInputSchema = z.object({
  customFieldIds: z.array(IdSchema).max(CUSTOM_FIELD_LIMITS.definitionsPerTenant),
});

/**
 * The list does not paginate, and keeps `CursorPage`'s shape so a generic list
 * client works against it unchanged. `definitionsPerTenant` is enforced on
 * create, so a bounded response is a promise the server can actually keep.
 */
export const CustomFieldDefinitionListResponseSchema = z.object({
  items: z.array(CustomFieldDefinitionSchema),
  /** Always null. Bounded by `CUSTOM_FIELD_LIMITS.definitionsPerTenant`. */
  nextCursor: z.null(),
});

/** A `date` custom field is a calendar date, not an instant — no time, no zone. */
export const CUSTOM_FIELD_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Custom field values cross the wire as strings keyed by field `key`, validated
 * against the definition's `type` on write. They are stored as `JSONB` on the
 * contact row rather than as entity-attribute-value rows, which keeps the
 * hottest read in the product — opening a conversation — free of an extra join.
 *
 * **On a response** this is every defined field the contact has a value for.
 * A key the contact has never been given is absent, not `null`; a client renders
 * the form from the definition list and reads values out of this map, so absent
 * and empty need no distinction.
 *
 * **On a write** it is a *merge*, not a replacement: keys present are set, an
 * explicit `null` clears one, and keys absent are left exactly as they were.
 * Replacement semantics would make an agent editing a phone number silently drop
 * every custom value their form did not happen to load.
 */
export const CustomFieldValuesSchema = z.record(z.string(), z.string().nullable());

/**
 * The single copy of "is this value legal for this field", so the console can
 * disable a save the API would refuse rather than keeping a second table of
 * rules in step. Returns `null` when the value is acceptable, otherwise the
 * message that rides in `validation_failed`'s `details[].message`.
 *
 * A `null` value always passes: clearing a field is legal for every type.
 */
export function customFieldValueIssue(
  definition: Pick<CustomFieldDefinition, 'type' | 'options'>,
  value: string | null,
): string | null {
  if (value === null) return null;

  switch (definition.type) {
    case 'text':
      return value.length > CUSTOM_FIELD_LIMITS.textValueLength
        ? `Must be at most ${String(CUSTOM_FIELD_LIMITS.textValueLength)} characters`
        : null;
    case 'number':
      // `Number('')` is 0 and `Number(' 1 ')` is 1; neither is a number a person typed.
      return value.trim() === '' || !Number.isFinite(Number(value)) ? 'Must be a number' : null;
    case 'boolean':
      return value === 'true' || value === 'false' ? null : 'Must be `true` or `false`';
    case 'date':
      return CUSTOM_FIELD_DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
        ? null
        : 'Must be a calendar date, `YYYY-MM-DD`';
    case 'select':
      return definition.options.includes(value) ? null : 'Must be one of the defined options';
  }
}

export const ContactResponseSchema = z.object({
  id: IdSchema,
  /** The WhatsApp identity, and the tenant-unique dedupe key. */
  phone: PhoneE164Schema,
  /** The contact's own WhatsApp profile name; `displayName` overrides it once an agent edits. */
  waProfileName: z.string().nullable(),
  displayName: z.string().min(1).max(120),
  email: z.email().nullable(),
  tags: z.array(TagSchema),
  customFields: CustomFieldValuesSchema,
  /** Denormalised for the contact list; the conversation remains the source of truth. */
  lastContactedAt: TimestampSchema.nullable(),
  /** Set when the contact opts out. Blocks every outbound send, including templates. */
  optedOutAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const ContactCreateInputSchema = z.object({
  phone: PhoneE164Schema,
  displayName: z.string().min(1).max(120),
  email: z.email().nullable().optional(),
  tagIds: z.array(IdSchema).default([]),
  customFields: CustomFieldValuesSchema.optional(),
});

/** Phone is the identity key and is not editable; merging contacts is a separate operation. */
export const ContactUpdateInputSchema = ContactCreateInputSchema.omit({ phone: true }).partial();

/**
 * Contact search is a single `q` matched against name, phone and email. A
 * structured filter DSL is deliberately deferred — nothing in TAR-18 asks for
 * one, and it is cheap to add behind this parameter later.
 */
export const ContactListQuerySchema = CursorPageQuerySchema.extend({
  q: z.string().min(1).max(120).optional(),
  tagId: IdSchema.optional(),
});

export type Tag = z.infer<typeof TagSchema>;
export type CustomFieldType = z.infer<typeof CustomFieldTypeSchema>;
export type CustomFieldDefinition = z.infer<typeof CustomFieldDefinitionSchema>;
export type CustomFieldDefinitionCreateInput = z.infer<
  typeof CustomFieldDefinitionCreateInputSchema
>;
export type CustomFieldDefinitionUpdateInput = z.infer<
  typeof CustomFieldDefinitionUpdateInputSchema
>;
export type CustomFieldDefinitionReorderInput = z.infer<
  typeof CustomFieldDefinitionReorderInputSchema
>;
export type CustomFieldDefinitionListResponse = z.infer<
  typeof CustomFieldDefinitionListResponseSchema
>;
export type CustomFieldValues = z.infer<typeof CustomFieldValuesSchema>;
export type ContactResponse = z.infer<typeof ContactResponseSchema>;
export type ContactCreateInput = z.infer<typeof ContactCreateInputSchema>;
export type ContactUpdateInput = z.infer<typeof ContactUpdateInputSchema>;
export type ContactListQuery = z.infer<typeof ContactListQuerySchema>;
