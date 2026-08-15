import { describe, expect, it } from 'vitest';
import { ROUTING_RULE_LIMITS, type AssignmentRuleResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { draftFromRule, validateRuleDraft, type RuleDraft } from './rule-form';

/**
 * The form's own rules. Each case here is a way a supervisor can fill the form in
 * that the API would refuse — caught next to the field instead of after a round
 * trip — plus the one thing an *edit* must not do: switch a disabled rule on.
 */

const TEAM_TARGET = { kind: 'team', teamId: '0192f002-0000-7000-8000-000000000201' } as const;

function draft(overrides: Partial<RuleDraft> = {}): RuleDraft {
  return {
    name: 'Billing keywords',
    conditions: [{ type: 'keyword', match: 'any', values: ['billing'] }],
    target: TEAM_TARGET,
    isActive: true,
    ...overrides,
  };
}

describe('validateRuleDraft', () => {
  it('accepts a complete rule and returns the parsed contract input', () => {
    const result = validateRuleDraft(draft(), content);

    expect(result).toStrictEqual({
      status: 'valid',
      input: {
        name: 'Billing keywords',
        conditions: [{ type: 'keyword', match: 'any', values: ['billing'] }],
        target: TEAM_TARGET,
        isActive: true,
      },
    });
  });

  it('trims the name and drops blank keyword lines rather than refusing them', () => {
    // A trailing newline in a textarea is not a mistake the user should be told
    // about, and neither is a pasted keyword with a leading space.
    const result = validateRuleDraft(
      draft({
        name: '  Billing keywords  ',
        conditions: [{ type: 'keyword', match: 'any', values: [' billing ', '', 'invoice'] }],
      }),
      content,
    );

    expect(result.status).toBe('valid');

    if (result.status === 'valid') {
      expect(result.input.name).toBe('Billing keywords');
      expect(result.input.conditions[0]).toStrictEqual({
        type: 'keyword',
        match: 'any',
        values: ['billing', 'invoice'],
      });
    }
  });

  it('names an empty rule name, condition list and target all at once', () => {
    const result = validateRuleDraft(draft({ name: '   ', conditions: [], target: null }), content);

    expect(result).toStrictEqual({
      status: 'invalid',
      errors: {
        name: content.routingRules.nameRequiredError,
        conditions: content.routingRules.conditionsRequiredError,
        target: content.routingRules.targetRequiredError,
        byCondition: {},
      },
    });
  });

  it('reports a keyword condition that is only blank lines, against its own row', () => {
    const result = validateRuleDraft(
      draft({
        conditions: [
          { type: 'business_hours', within: false },
          { type: 'keyword', match: 'any', values: ['  ', ''] },
        ],
      }),
      content,
    );

    expect(result.status).toBe('invalid');

    if (result.status === 'invalid') {
      expect(result.errors.byCondition).toStrictEqual({
        1: content.routingRules.keywordValuesRequiredError,
      });
    }
  });

  it('reports a tag condition with nothing selected', () => {
    const result = validateRuleDraft(
      draft({ conditions: [{ type: 'tag', match: 'any', tagIds: [] }] }),
      content,
    );

    expect(result.status).toBe('invalid');

    if (result.status === 'invalid') {
      expect(result.errors.byCondition[0]).toBe(content.routingRules.tagsRequiredError);
    }
  });

  it('reports a tag condition holding more tags than the contract allows', () => {
    // A workspace with more than 25 tags can check them all: without this the
    // schema refuses the input and the form falls back to its generic error.
    const tagIds = Array.from(
      { length: ROUTING_RULE_LIMITS.valuesPerCondition + 1 },
      (_, index) => `0192f00c-0000-7000-8000-${String(index).padStart(12, '0')}`,
    );

    const result = validateRuleDraft(
      draft({ conditions: [{ type: 'tag', match: 'any', tagIds }] }),
      content,
    );

    expect(result.status).toBe('invalid');

    if (result.status === 'invalid') {
      expect(result.errors.byCondition[0]).toBe(
        content.routingRules.tagsTooManyError(ROUTING_RULE_LIMITS.valuesPerCondition),
      );
      expect(result.errors.form).toBeUndefined();
    }
  });

  it('requires a value for an operator that compares against one, and not otherwise', () => {
    const missing = validateRuleDraft(
      draft({
        conditions: [
          { type: 'contact_attribute', key: 'plan_tier', operator: 'equals', value: '' },
        ],
      }),
      content,
    );
    const valueless = validateRuleDraft(
      draft({
        conditions: [
          { type: 'contact_attribute', key: 'plan_tier', operator: 'is_set', value: null },
        ],
      }),
      content,
    );

    expect(missing.status).toBe('invalid');
    expect(valueless.status).toBe('valid');
  });

  it('carries the rule’s own on/off state instead of defaulting it back on', () => {
    // Fixing a typo in a disabled rule's name must not quietly re-enable it.
    const result = validateRuleDraft(draft({ isActive: false }), content);

    expect(result.status).toBe('valid');

    if (result.status === 'valid') {
      expect(result.input.isActive).toBe(false);
    }
  });
});

describe('draftFromRule', () => {
  it('starts a new rule empty and active', () => {
    expect(draftFromRule(null)).toStrictEqual({
      name: '',
      conditions: [],
      target: null,
      isActive: true,
    });
  });

  it('carries an existing rule’s target-less, disabled state through unchanged', () => {
    const orphan: AssignmentRuleResponse = {
      id: '0192f00b-0000-7000-8000-000000000b04',
      name: 'Escalations',
      position: 3,
      isActive: false,
      conditions: [{ type: 'keyword', match: 'all', values: ['urgent'] }],
      target: null,
      createdAt: '2026-08-10T09:15:00.000Z',
      updatedAt: '2026-08-12T08:00:00.000Z',
    };

    expect(draftFromRule(orphan)).toStrictEqual({
      name: 'Escalations',
      conditions: orphan.conditions,
      target: null,
      isActive: false,
    });
  });
});
