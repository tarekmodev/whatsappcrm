import { describe, expect, it } from 'vitest';
import type { CustomFieldDefinition } from '@whatsappcrm/contracts';
import {
  changedCustomFieldKeys,
  contactTagPatch,
  customFieldDraft,
  customFieldIssues,
  customFieldPatch,
} from './custom-field-values';

/**
 * 0002 amendment 10's three load-bearing rules, at the level the contact profile
 * form implements them: a write is a merge, a cleared field is an explicit
 * `null`, and only a value the agent actually changed is validated.
 */

function definition(overrides: Partial<CustomFieldDefinition>): CustomFieldDefinition {
  return {
    id: '0192f00c-0000-7000-8000-000000000c01',
    key: 'plan_tier',
    label: 'Plan tier',
    type: 'text',
    options: [],
    position: 0,
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  };
}

const PLAN_TIER = definition({
  type: 'select',
  options: ['bronze', 'silver', 'gold'],
});

const ACCOUNT_MANAGER = definition({
  id: '0192f00c-0000-7000-8000-000000000c02',
  key: 'account_manager',
  label: 'Account manager',
  type: 'text',
  position: 1,
});

const DEFINITIONS = [PLAN_TIER, ACCOUNT_MANAGER];

describe('customFieldDraft', () => {
  it('gives every definition an entry, whether or not the contact has a value', () => {
    expect(customFieldDraft(DEFINITIONS, { plan_tier: 'gold' })).toEqual({
      plan_tier: 'gold',
      account_manager: '',
    });
  });

  it('ignores a stored key that no definition claims, so it is never editable', () => {
    // A value left behind by a definition somebody deleted. It is not offered
    // for editing, and — because the patch is a merge — it is not touched either.
    expect(customFieldDraft(DEFINITIONS, { retired_field: 'x' })).toEqual({
      plan_tier: '',
      account_manager: '',
    });
  });

  it('reads a null the same as an absent key', () => {
    expect(customFieldDraft([ACCOUNT_MANAGER], { account_manager: null })).toEqual({
      account_manager: '',
    });
  });
});

describe('customFieldPatch', () => {
  it('is null when nothing changed, so an empty write is never sent', () => {
    const initial = customFieldDraft(DEFINITIONS, { plan_tier: 'gold' });

    expect(customFieldPatch(DEFINITIONS, initial, initial)).toBeNull();
  });

  it('carries only the keys that changed, not the whole map', () => {
    const initial = customFieldDraft(DEFINITIONS, { plan_tier: 'gold' });

    expect(
      customFieldPatch(DEFINITIONS, initial, { ...initial, account_manager: 'Priya Raman' }),
    ).toEqual({ account_manager: 'Priya Raman' });
  });

  it('sends an explicit null for a field the agent emptied', () => {
    // Omitting it would mean "leave it as it was", and the clear would silently
    // do nothing.
    const initial = customFieldDraft(DEFINITIONS, { plan_tier: 'gold' });

    expect(customFieldPatch(DEFINITIONS, initial, { ...initial, plan_tier: '' })).toEqual({
      plan_tier: null,
    });
  });

  it('treats whitespace as empty rather than storing padding nobody typed', () => {
    const initial = customFieldDraft(DEFINITIONS, { plan_tier: 'gold' });

    expect(customFieldPatch(DEFINITIONS, initial, { ...initial, plan_tier: '   ' })).toEqual({
      plan_tier: null,
    });
  });

  it('does not count re-typing the same value with padding as a change', () => {
    const initial = customFieldDraft(DEFINITIONS, { account_manager: 'Priya Raman' });

    expect(
      customFieldPatch(DEFINITIONS, initial, { ...initial, account_manager: ' Priya Raman ' }),
    ).toBeNull();
  });
});

describe('customFieldIssues', () => {
  it('reports a value the API would refuse, using the contract’s own message', () => {
    const numberField = definition({ key: 'seats', label: 'Seats', type: 'number' });
    const initial = customFieldDraft([numberField], {});

    expect(customFieldIssues([numberField], initial, { seats: 'lots' })).toEqual({
      seats: 'Must be a number',
    });
  });

  it('accepts clearing a field of any type', () => {
    const dateField = definition({ key: 'renews_on', label: 'Renews on', type: 'date' });
    const initial = customFieldDraft([dateField], { renews_on: '2026-09-01' });

    expect(customFieldIssues([dateField], initial, { renews_on: '' })).toEqual({});
  });

  /**
   * Amendment 10: removing an option from a `select` rewrites no contact, and a
   * value outside the current list survives until that field is next written. So
   * a stale value must not block a save of some *other* field.
   */
  it('leaves a stale select value alone while it is untouched', () => {
    const initial = customFieldDraft(DEFINITIONS, { plan_tier: 'platinum' });

    expect(
      customFieldIssues(DEFINITIONS, initial, { ...initial, account_manager: 'Priya Raman' }),
    ).toEqual({});
  });

  it('refuses a stale select value once the agent edits that field to another bad one', () => {
    const initial = customFieldDraft(DEFINITIONS, { plan_tier: 'platinum' });

    expect(customFieldIssues(DEFINITIONS, initial, { ...initial, plan_tier: 'titanium' })).toEqual({
      plan_tier: 'Must be one of the defined options',
    });
  });
});

describe('changedCustomFieldKeys', () => {
  it('names only the definitions whose control moved', () => {
    const initial = customFieldDraft(DEFINITIONS, { plan_tier: 'gold' });

    expect(
      changedCustomFieldKeys(DEFINITIONS, initial, { ...initial, plan_tier: 'silver' }),
    ).toEqual(['plan_tier']);
  });
});

describe('contactTagPatch', () => {
  it('is null when the same tags are selected in a different order', () => {
    // Order is not meaningful for a tag set, and the API may return them in any.
    expect(contactTagPatch(['a', 'b'], ['b', 'a'])).toBeNull();
  });

  it('carries the whole selection once it differs', () => {
    expect(contactTagPatch(['a'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('carries an empty array when every tag was removed', () => {
    // Not `null`: "remove them all" is a change, and omitting `tagIds` would
    // leave the contact tagged.
    expect(contactTagPatch(['a'], [])).toEqual([]);
  });
});
