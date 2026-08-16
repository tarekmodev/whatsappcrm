import { describe, expect, it } from 'vitest';
import { CUSTOM_FIELD_LIMITS } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import {
  clearIssue,
  definitionIssues,
  optionsToText,
  parseOptionsText,
  suggestKeyFromLabel,
} from './definition-form';

/**
 * The definition form refuses exactly what the API refuses, so an admin reads a
 * message beside the field rather than a 422 after a round trip.
 */

const TEXT_DRAFT = {
  label: 'Plan tier',
  key: 'plan_tier',
  type: 'text' as const,
  optionsText: '',
};

describe('parseOptionsText', () => {
  it('takes one option per line, trimmed', () => {
    expect(parseOptionsText(' bronze \nsilver\n gold')).toEqual(['bronze', 'silver', 'gold']);
  });

  it('drops blank lines rather than sending an empty option', () => {
    // A trailing newline is what a textarea gives you for free; refusing the
    // form over it would be a validation error nobody typed.
    expect(parseOptionsText('bronze\n\n\ngold\n')).toEqual(['bronze', 'gold']);
  });

  it('round-trips through optionsToText', () => {
    expect(parseOptionsText(optionsToText(['bronze', 'gold']))).toEqual(['bronze', 'gold']);
  });
});

describe('suggestKeyFromLabel', () => {
  it('turns a label into a legal machine key', () => {
    expect(suggestKeyFromLabel('Plan tier')).toBe('plan_tier');
  });

  it('collapses punctuation and trims the underscores it would leave behind', () => {
    expect(suggestKeyFromLabel('  Account manager (EMEA)!  ')).toBe('account_manager_emea');
  });

  it('never exceeds the key length the contract allows', () => {
    expect(suggestKeyFromLabel('a'.repeat(200))).toHaveLength(CUSTOM_FIELD_LIMITS.keyLength);
  });
});

describe('definitionIssues', () => {
  it('accepts a well-formed text definition', () => {
    expect(definitionIssues(TEXT_DRAFT, { isKeyEditable: true })).toEqual({});
  });

  it('requires a label', () => {
    expect(definitionIssues({ ...TEXT_DRAFT, label: '   ' }, { isKeyEditable: true })).toEqual({
      label: content.form.requiredFieldError,
    });
  });

  it('refuses a key that is not lowercase snake case', () => {
    expect(definitionIssues({ ...TEXT_DRAFT, key: 'Plan-Tier' }, { isKeyEditable: true })).toEqual({
      key: content.customFields.keyInvalidError,
    });
  });

  /**
   * `RESERVED_CUSTOM_FIELD_KEYS`. Nothing breaks if one is used — the routing
   * engine reads `contacts.custom_fields` and only those — but a tenant-defined
   * `email` rendered beside the real one is a support ticket waiting to happen.
   */
  it('refuses a key that would shadow a built-in contact field, with its own message', () => {
    expect(definitionIssues({ ...TEXT_DRAFT, key: 'email' }, { isKeyEditable: true })).toEqual({
      key: content.customFields.keyReservedError,
    });
  });

  it('says nothing about the key when editing, because the key is immutable', () => {
    // An edit dialog does not offer the key, so reporting a problem with it
    // would be unactionable.
    expect(definitionIssues({ ...TEXT_DRAFT, key: 'NOT A KEY' }, { isKeyEditable: false })).toEqual(
      {},
    );
  });

  it('requires at least one option for a select', () => {
    expect(
      definitionIssues(
        { ...TEXT_DRAFT, type: 'select', optionsText: '  ' },
        { isKeyEditable: true },
      ),
    ).toEqual({ options: content.customFields.optionsRequiredError });
  });

  it('refuses duplicate options', () => {
    expect(
      definitionIssues(
        { ...TEXT_DRAFT, type: 'select', optionsText: 'gold\ngold' },
        { isKeyEditable: true },
      ),
    ).toEqual({ options: content.customFields.optionsDuplicateError });
  });

  it('refuses more options than the contract allows', () => {
    const optionsText = Array.from(
      { length: CUSTOM_FIELD_LIMITS.optionsPerDefinition + 1 },
      (_unused, index) => `option-${String(index)}`,
    ).join('\n');

    expect(
      definitionIssues({ ...TEXT_DRAFT, type: 'select', optionsText }, { isKeyEditable: true }),
    ).toEqual({
      options: content.customFields.optionsTooManyError(CUSTOM_FIELD_LIMITS.optionsPerDefinition),
    });
  });

  it('refuses an option longer than the contract allows', () => {
    expect(
      definitionIssues(
        {
          ...TEXT_DRAFT,
          type: 'select',
          optionsText: 'a'.repeat(CUSTOM_FIELD_LIMITS.optionLength + 1),
        },
        { isKeyEditable: true },
      ),
    ).toEqual({
      options: content.customFields.optionsTooLongError(CUSTOM_FIELD_LIMITS.optionLength),
    });
  });

  it('says nothing about options for a type that may not carry them', () => {
    // The textarea is not rendered for a non-select, so a stale draft value
    // must not block the form.
    expect(
      definitionIssues({ ...TEXT_DRAFT, optionsText: 'left over' }, { isKeyEditable: true }),
    ).toEqual({});
  });
});

describe('clearIssue', () => {
  it('drops one field’s message and leaves the rest', () => {
    expect(clearIssue({ label: 'a', key: 'b' }, 'label')).toEqual({ key: 'b' });
  });

  it('returns the same object when there was nothing to clear', () => {
    // Identity, not equality: an edit to a field with no error must not
    // re-render every other one.
    const issues = { key: 'b' };

    expect(clearIssue(issues, 'label')).toBe(issues);
  });
});
