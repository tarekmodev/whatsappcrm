import type { CustomFieldDefinition } from '@whatsappcrm/contracts';
import { CustomFieldValuesInvalidError } from './contacts.errors';
import { mergeCustomFieldValues } from './custom-field-values';

/**
 * The write half of `ContactResponse.customFields`, which 0002 amendment 10
 * rules on twice — a write is a *merge*, and an unknown key is refused rather
 * than dropped. Both are decisions a client depends on and neither is visible
 * from the schema, so they are asserted here rather than inferred from the
 * service that calls this.
 *
 * No database: this is a pure function over a definition list, and the isolation
 * these values live behind is asserted in `contacts-tenant-isolation.int-spec.ts`.
 */

function definition(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: '0192f0ff-0000-7000-8000-00000000c001',
    key: 'tier',
    label: 'Account tier',
    type: 'text',
    options: [],
    position: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const TIER = definition();
const SEATS = definition({
  id: '0192f0ff-0000-7000-8000-00000000c002',
  key: 'seats',
  type: 'number',
});
const PLAN = definition({
  id: '0192f0ff-0000-7000-8000-00000000c003',
  key: 'plan',
  type: 'select',
  options: ['gold', 'silver'],
});

/** The message an invalid value lands with, at the path amendment 10 publishes. */
function issuePaths(error: unknown): string[] {
  return error instanceof CustomFieldValuesInvalidError
    ? error.issues.map((issue) => issue.path)
    : [];
}

describe('merging custom field values', () => {
  it('leaves a key the write does not carry exactly as it was', () => {
    // The decision this file exists for. Replacement would make an agent editing
    // a phone number silently erase every value their form did not load.
    const merged = mergeCustomFieldValues({ tier: 'gold', seats: '4' }, { tier: 'silver' }, [
      TIER,
      SEATS,
    ]);

    expect(merged).toEqual({ tier: 'silver', seats: '4' });
  });

  it('clears a value on an explicit null, and stores no null', () => {
    // A key the contact has never been given is *absent* from a response, so
    // storing `null` would publish a distinction the schema says does not exist.
    const merged = mergeCustomFieldValues({ tier: 'gold', seats: '4' }, { tier: null }, [
      TIER,
      SEATS,
    ]);

    expect(merged).toEqual({ seats: '4' });
    expect('tier' in merged).toBe(false);
  });

  it('sets a key the contact has never held', () => {
    expect(mergeCustomFieldValues({}, { tier: 'gold' }, [TIER])).toEqual({ tier: 'gold' });
  });

  it('refuses an unknown key rather than dropping it', () => {
    // Silently dropping it is the failure shape amendment 10 refuses everywhere:
    // a typo that stores nothing and reports success.
    expect(() => mergeCustomFieldValues({}, { teir: 'gold' }, [TIER])).toThrow(
      CustomFieldValuesInvalidError,
    );
  });

  it('names every offending key at once, so a form is fixed in one pass', () => {
    let caught: unknown;

    try {
      mergeCustomFieldValues({}, { teir: 'gold', seats: 'four' }, [TIER, SEATS]);
    } catch (error) {
      caught = error;
    }

    expect(issuePaths(caught)).toEqual(['customFields.teir', 'customFields.seats']);
  });

  it('validates through the contract’s own rules, per type', () => {
    // `customFieldValueIssue` is the single copy, so the console can disable a
    // save the API would refuse. These assert it is actually consulted.
    expect(() => mergeCustomFieldValues({}, { seats: '4' }, [SEATS])).not.toThrow();
    expect(() => mergeCustomFieldValues({}, { seats: ' ' }, [SEATS])).toThrow(
      CustomFieldValuesInvalidError,
    );
    expect(() => mergeCustomFieldValues({}, { plan: 'gold' }, [PLAN])).not.toThrow();
    expect(() => mergeCustomFieldValues({}, { plan: 'bronze' }, [PLAN])).toThrow(
      CustomFieldValuesInvalidError,
    );
  });

  it('clears a field of any type, because null always passes', () => {
    expect(
      mergeCustomFieldValues({ seats: '4', plan: 'gold' }, { seats: null, plan: null }, [
        SEATS,
        PLAN,
      ]),
    ).toEqual({});
  });

  it('does not re-validate a stored value the write does not carry', () => {
    // Removing an option from a `select` rewrites no contact: a stored value
    // outside the current options survives until that field is next written, and
    // must not block a save of some *other* field.
    const stale = { plan: 'bronze', tier: 'gold' };

    expect(mergeCustomFieldValues(stale, { tier: 'silver' }, [PLAN, TIER])).toEqual({
      plan: 'bronze',
      tier: 'silver',
    });
  });
});
