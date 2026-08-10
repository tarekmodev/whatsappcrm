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

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'select'] as const;
export const CustomFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES);

export const CustomFieldDefinitionSchema = z.object({
  id: IdSchema,
  /** Stable machine key; `label` is what users see and may be renamed freely. */
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(80),
  type: CustomFieldTypeSchema,
  /** Populated only when `type` is `select`. */
  options: z.array(z.string()).default([]),
});

/**
 * Custom field values cross the wire as strings keyed by field `key`, coerced
 * against the definition's `type` on write. They are stored as `JSONB` on the
 * contact row rather than as entity-attribute-value rows, which keeps the
 * hottest read in the product — opening a conversation — free of an extra join.
 */
export const CustomFieldValuesSchema = z.record(z.string(), z.string().nullable());

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
export type ContactResponse = z.infer<typeof ContactResponseSchema>;
export type ContactCreateInput = z.infer<typeof ContactCreateInputSchema>;
export type ContactUpdateInput = z.infer<typeof ContactUpdateInputSchema>;
export type ContactListQuery = z.infer<typeof ContactListQuerySchema>;
