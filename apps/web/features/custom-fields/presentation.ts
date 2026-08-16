import { CUSTOM_FIELD_TYPES, type CustomFieldType } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { SelectOption } from '@/components/ui/Select';

/**
 * Maps a `CustomFieldType` onto presentation, so the admin table and the create
 * dialog name a type identically — and so a sixth type means editing one table.
 */

export function customFieldTypeOptions(): SelectOption[] {
  return CUSTOM_FIELD_TYPES.map((type) => ({
    value: type,
    label: content.customFieldTypes[type],
  }));
}

/**
 * Narrows an untrusted `<select>` value back to the union.
 *
 * A native select cannot produce anything but one of its own options, so this is
 * belt and braces — but it is what keeps the cast out of the dialog, and the
 * fallback is the type the dialog opens on.
 */
export function parseCustomFieldType(value: string): CustomFieldType {
  return CUSTOM_FIELD_TYPES.find((type) => type === value) ?? 'text';
}
