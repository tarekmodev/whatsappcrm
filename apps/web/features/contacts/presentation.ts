import {
  CUSTOM_FIELD_DATE_PATTERN,
  type CustomFieldDefinition,
  type Tag,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { SelectOption } from '@/components/ui/Select';

/**
 * Maps the contact vocabulary onto presentation, so the profile form, the
 * read-only profile and the directory's filter all phrase a value identically.
 *
 * The type-driven decisions live here rather than in a component because there
 * are two renderers of the same value — an editable control and a static line —
 * and a `select` whose stale option shows in one but not the other is the bug
 * this module exists to prevent.
 */

/** Empty string, not a sentinel: a native `<select>`'s value is always a string. */
export const UNSET_VALUE = '';

/**
 * The options a `select` field offers, plus an explicit "not set" row.
 *
 * A stored value that is no longer one of the definition's options is offered
 * back as its own row. Amendment 10 keeps such a value on the contact until that
 * field is next written, so a picker that dropped it would silently rewrite it
 * the moment the agent saved anything else on the form.
 */
export function customFieldSelectOptions(
  definition: CustomFieldDefinition,
  currentValue: string,
): SelectOption[] {
  const options: SelectOption[] = [
    { value: UNSET_VALUE, label: content.contacts.selectUnset },
    ...definition.options.map((option) => ({ value: option, label: option })),
  ];

  if (isStaleSelectValue(definition, currentValue)) {
    options.push({ value: currentValue, label: currentValue });
  }

  return options;
}

/** True when the contact holds a `select` value the definition no longer offers. */
export function isStaleSelectValue(definition: CustomFieldDefinition, value: string): boolean {
  return (
    definition.type === 'select' && value !== UNSET_VALUE && !definition.options.includes(value)
  );
}

/**
 * `true` / `false` as the contract stores them — strings, because a custom field
 * value crosses the wire as a string whatever its type.
 */
export function booleanSelectOptions(): SelectOption[] {
  return [
    { value: UNSET_VALUE, label: content.contacts.booleanUnset },
    { value: 'true', label: content.contacts.booleanTrue },
    { value: 'false', label: content.contacts.booleanFalse },
  ];
}

/**
 * A stored value as a reader sees it, for the variant of the profile that cannot
 * edit. Never the raw string for a `boolean`, and never a bare ISO date.
 */
export function formatCustomFieldValue(
  definition: CustomFieldDefinition,
  value: string | null | undefined,
): string {
  if (value === null || value === undefined || value === UNSET_VALUE) {
    return content.contacts.notSet;
  }

  switch (definition.type) {
    case 'boolean':
      return value === 'true' ? content.contacts.booleanTrue : content.contacts.booleanFalse;
    case 'date':
      return formatCalendarDate(value);
    case 'text':
    case 'number':
    case 'select':
      return value;
  }
}

/**
 * A calendar date, not an instant. Formatted in UTC deliberately: the value has
 * no time and no zone, and rendering it in the reader's zone would show the day
 * before for anyone west of Greenwich.
 */
function formatCalendarDate(value: string): string {
  if (!CUSTOM_FIELD_DATE_PATTERN.test(value)) {
    // A value stored before its definition's type was what it is today. Shown
    // as-is rather than as `Invalid Date`; it is stale, not corrupt.
    return value;
  }

  return new Intl.DateTimeFormat(content.locale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

/**
 * The directory's tag filter, with "All tags" first.
 *
 * A tag id in the URL that resolves to nothing is offered back as an "Unknown
 * tag" row rather than dropped: a `<select>` whose value is not among its
 * options silently shows the first one, and the filter would then claim to be
 * off while the list stayed narrowed.
 */
export function tagFilterOptions(
  tags: readonly Tag[],
  activeTagId: string | undefined,
): SelectOption[] {
  const options: SelectOption[] = [
    { value: UNSET_VALUE, label: content.contacts.allTags },
    ...tags.map((tag) => ({ value: tag.id, label: tag.name })),
  ];

  if (activeTagId !== undefined && !tags.some((tag) => tag.id === activeTagId)) {
    options.push({ value: activeTagId, label: content.contacts.unknownTagOption });
  }

  return options;
}
