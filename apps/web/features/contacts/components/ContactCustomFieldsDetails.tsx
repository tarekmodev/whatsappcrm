import type { ContactResponse, CustomFieldDefinition } from '@whatsappcrm/contracts';
import { DetailList } from '@/components/ui/DetailList';
import { formatCustomFieldValue } from '../presentation';

/**
 * A contact's custom field values as text, for a principal who may not edit
 * them. Usage:
 * `<ContactCustomFieldsDetails contact={contact} definitions={definitions} />`.
 *
 * Static values rather than disabled controls: a disabled input implies "not
 * right now", it is skipped by keyboard navigation, and its value becomes
 * unreadable to anyone tabbing through.
 *
 * Rendered from the **definition list**, in `position` order, so a read-only
 * profile shows every field the tenant defines — including the ones this
 * contact has no value for — rather than only the ones that happen to be set.
 */
export function ContactCustomFieldsDetails({
  contact,
  definitions,
}: {
  contact: ContactResponse;
  definitions: readonly CustomFieldDefinition[];
}) {
  return (
    <DetailList
      items={definitions.map((definition) => ({
        id: definition.id,
        term: definition.label,
        value: formatCustomFieldValue(definition, contact.customFields[definition.key]),
      }))}
    />
  );
}
