import { describe, expect, it } from 'vitest';
import {
  AssignmentRuleCreateInputSchema,
  AssignmentRuleResponseSchema,
  ContactAttributeConditionSchema,
  ROUTING_RULE_LIMITS,
  RoutingConditionSchema,
  RoutingTargetSchema,
  contactAttributeOperatorTakesValue,
} from './assignment';

/**
 * The rules from 0007 that a reader cannot derive from the shape, and that the
 * console and the API would otherwise be free to disagree about.
 */

const TEAM_ID = '019fed83-ebd1-774d-86e4-46137546a539';
const USER_ID = '019fee01-3c7a-7b2e-9f14-2c8b5a0d61aa';

describe('RoutingConditionSchema', () => {
  it('accepts the four condition types TAR-24 commits to at launch', () => {
    const conditions = [
      { type: 'keyword', match: 'any', values: ['billing'] },
      { type: 'tag', match: 'all', tagIds: [TEAM_ID] },
      { type: 'business_hours', within: false },
      { type: 'contact_attribute', key: 'plan_tier', operator: 'equals', value: 'gold' },
    ];

    for (const condition of conditions) {
      expect(RoutingConditionSchema.safeParse(condition).success).toBe(true);
    }
  });

  it('rejects a condition type outside the closed set', () => {
    // A nested boolean tree is TAR-27's automation engine, not this grammar.
    expect(RoutingConditionSchema.safeParse({ type: 'all', conditions: [] }).success).toBe(false);
  });

  it('caps the values in one condition, so evaluation cost stays bounded', () => {
    const values = Array.from(
      { length: ROUTING_RULE_LIMITS.valuesPerCondition + 1 },
      (_unused, index) => `keyword-${String(index)}`,
    );

    expect(
      RoutingConditionSchema.safeParse({ type: 'keyword', match: 'any', values }).success,
    ).toBe(false);
  });
});

describe('ContactAttributeConditionSchema', () => {
  it('requires a value for every operator that compares against one', () => {
    expect(
      ContactAttributeConditionSchema.safeParse({
        type: 'contact_attribute',
        key: 'plan_tier',
        operator: 'equals',
        value: null,
      }).success,
    ).toBe(false);
  });

  it('refuses a value for `is_set` and `is_not_set`, which compare against nothing', () => {
    expect(
      ContactAttributeConditionSchema.safeParse({
        type: 'contact_attribute',
        key: 'plan_tier',
        operator: 'is_set',
        value: 'gold',
      }).success,
    ).toBe(false);
  });

  it('names a `custom_field_defs.key`, not a free-text attribute path', () => {
    expect(
      ContactAttributeConditionSchema.safeParse({
        type: 'contact_attribute',
        key: 'contact.email.domain',
        operator: 'is_set',
        value: null,
      }).success,
    ).toBe(false);
  });

  it('agrees with the helper the console builds its form from', () => {
    expect(contactAttributeOperatorTakesValue('contains')).toBe(true);
    expect(contactAttributeOperatorTakesValue('is_not_set')).toBe(false);
  });
});

describe('RoutingTargetSchema', () => {
  it('accepts a team target and a user target', () => {
    expect(RoutingTargetSchema.safeParse({ kind: 'team', teamId: TEAM_ID }).success).toBe(true);
    expect(RoutingTargetSchema.safeParse({ kind: 'user', userId: USER_ID }).success).toBe(true);
  });

  it('yields exactly one id, so "assigned to" is never ambiguous downstream', () => {
    // The discriminator is what carries the guarantee: a `team` target parses to a
    // `teamId` and nothing else, whatever the caller also sent. The API maps that
    // onto the two nullable columns, so a rule can never name both.
    const parsed = RoutingTargetSchema.parse({ kind: 'team', teamId: TEAM_ID, userId: USER_ID });

    expect(parsed).toStrictEqual({ kind: 'team', teamId: TEAM_ID });
  });

  it('refuses a target that names no id, and a kind outside the union', () => {
    expect(RoutingTargetSchema.safeParse({ kind: 'team' }).success).toBe(false);
    expect(RoutingTargetSchema.safeParse({ kind: 'everyone' }).success).toBe(false);
  });
});

describe('AssignmentRuleCreateInputSchema', () => {
  it('refuses an empty condition list', () => {
    // A rule that matches everything, placed anywhere but last, silently swallows
    // all routing — and the thing it would express is already the fallback.
    expect(
      AssignmentRuleCreateInputSchema.safeParse({
        name: 'Everything',
        conditions: [],
        target: { kind: 'team', teamId: TEAM_ID },
      }).success,
    ).toBe(false);
  });

  it('defaults a new rule to active and lets the server choose its position', () => {
    const parsed = AssignmentRuleCreateInputSchema.parse({
      name: 'Billing keywords',
      conditions: [{ type: 'keyword', match: 'any', values: ['billing'] }],
      target: { kind: 'team', teamId: TEAM_ID },
    });

    expect(parsed.isActive).toBe(true);
    expect(parsed.position).toBeUndefined();
  });
});

describe('AssignmentRuleResponseSchema', () => {
  it('allows a null target, which is the orphan user removal leaves behind', () => {
    const parsed = AssignmentRuleResponseSchema.safeParse({
      id: USER_ID,
      name: 'Was routed to Liang',
      position: 0,
      isActive: false,
      conditions: [{ type: 'keyword', match: 'any', values: ['billing'] }],
      target: null,
      createdAt: '2026-08-12T09:14:02.118+03:00',
      updatedAt: '2026-08-12T09:14:02.118+03:00',
    });

    expect(parsed.success).toBe(true);
  });
});
