import { describe, expect, it } from 'vitest';
import type {
  CustomFieldDefinition,
  Tag,
  TeamResponse,
  UserResponse,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import {
  availableConditionTypes,
  blankCondition,
  describeCondition,
  describeTarget,
  movedRuleIds,
  withOperator,
  type RoutingRuleVocabulary,
} from './presentation';

/**
 * What a rule *says* is the whole point of the list surface, so the sentence each
 * condition turns into is tested rather than eyeballed — including the two cases
 * a supervisor is most likely to hit and least likely to expect: `any` versus
 * `all`, and a tag that was deleted after the rule was written.
 */

const TEAM: TeamResponse = {
  id: '0192f002-0000-7000-8000-000000000201',
  name: 'Billing',
  description: null,
  memberUserIds: [],
  createdAt: '2026-07-02T10:10:00.000Z',
};

const USER: UserResponse = {
  id: '0192f001-0000-7000-8000-000000000102',
  email: 'priya@northwind.example',
  displayName: 'Priya Raman',
  avatarUrl: null,
  role: 'supervisor',
  status: 'active',
  availability: 'available',
  teamIds: [],
  occupiesSeat: true,
  lastSeenAt: null,
  security: null,
  createdAt: '2026-07-02T10:05:00.000Z',
};

const TAG: Tag = { id: '0192f009-0000-7000-8000-000000000901', name: 'VIP', color: '#7c3aed' };

const FIELD: CustomFieldDefinition = {
  id: '0192f00a-0000-7000-8000-000000000a01',
  key: 'plan_tier',
  label: 'Plan tier',
  type: 'select',
  options: ['gold'],
  position: 0,
  createdAt: '2026-06-01T09:00:00.000Z',
  updatedAt: '2026-06-01T09:00:00.000Z',
};

const VOCABULARY: RoutingRuleVocabulary = {
  teams: [TEAM],
  users: [USER],
  tags: [TAG],
  customFields: [FIELD],
};

describe('describeCondition', () => {
  it('phrases `any` as a choice and `all` as a requirement', () => {
    const any = describeCondition(
      { type: 'keyword', match: 'any', values: ['billing', 'invoice'] },
      VOCABULARY,
      content,
    );
    const all = describeCondition(
      { type: 'keyword', match: 'all', values: ['billing', 'invoice'] },
      VOCABULARY,
      content,
    );

    expect(any).toContain('or');
    expect(all).toContain('and');
  });

  it('names tags rather than showing their ids', () => {
    const summary = describeCondition(
      { type: 'tag', match: 'any', tagIds: [TAG.id] },
      VOCABULARY,
      content,
    );

    expect(summary).toContain(TAG.name);
    expect(summary).not.toContain(TAG.id);
  });

  it('says a referenced tag is gone rather than printing a raw uuid', () => {
    // The rule really does still reference it, so the clause stays — the
    // supervisor is the one who has to decide what to do about that.
    const summary = describeCondition(
      { type: 'tag', match: 'any', tagIds: ['0192f009-0000-7000-8000-0000000009ff'] },
      VOCABULARY,
      content,
    );

    expect(summary).toContain(content.routingRules.summaryUnknownReference);
    expect(summary).not.toContain('0192f009');
  });

  it('distinguishes inside from outside business hours', () => {
    expect(describeCondition({ type: 'business_hours', within: true }, VOCABULARY, content)).toBe(
      content.routingRules.summaryBusinessHoursWithin,
    );
    expect(describeCondition({ type: 'business_hours', within: false }, VOCABULARY, content)).toBe(
      content.routingRules.summaryBusinessHoursOutside,
    );
  });

  it('reads a contact-field condition as a sentence, with and without a value', () => {
    const withValue = describeCondition(
      { type: 'contact_attribute', key: FIELD.key, operator: 'equals', value: 'gold' },
      VOCABULARY,
      content,
    );
    const withoutValue = describeCondition(
      { type: 'contact_attribute', key: FIELD.key, operator: 'is_not_set', value: null },
      VOCABULARY,
      content,
    );

    expect(withValue).toContain(FIELD.label);
    expect(withValue).toContain('gold');
    expect(withoutValue).toContain(content.routingRules.operatorIsNotSet);
  });
});

describe('describeTarget', () => {
  it('names the team or the agent', () => {
    expect(describeTarget({ kind: 'team', teamId: TEAM.id }, VOCABULARY, content)).toContain(
      TEAM.name,
    );
    expect(describeTarget({ kind: 'user', userId: USER.id }, VOCABULARY, content)).toBe(
      USER.displayName,
    );
  });

  it('explains a missing target instead of rendering nothing', () => {
    expect(describeTarget(null, VOCABULARY, content)).toBe(content.routingRules.targetMissing);
  });
});

describe('movedRuleIds', () => {
  const IDS = ['a', 'b', 'c'];

  it('swaps a rule past its neighbour, and returns the whole set', () => {
    expect(movedRuleIds(IDS, 'b', 'up')).toStrictEqual(['b', 'a', 'c']);
    expect(movedRuleIds(IDS, 'b', 'down')).toStrictEqual(['a', 'c', 'b']);
  });

  it('refuses a move off either end, so the list never sends an unchanged order', () => {
    expect(movedRuleIds(IDS, 'a', 'up')).toBeNull();
    expect(movedRuleIds(IDS, 'c', 'down')).toBeNull();
  });

  it('refuses to move a rule that is not in the set', () => {
    expect(movedRuleIds(IDS, 'z', 'up')).toBeNull();
  });
});

describe('availableConditionTypes', () => {
  it('drops the types a workspace has nothing to match on', () => {
    // A tag condition with no tags to choose from can only ever be an invalid
    // rule, so offering it would send the supervisor straight to a refusal.
    const types = availableConditionTypes({ ...VOCABULARY, tags: [], customFields: [] });

    expect(types).toStrictEqual(['keyword', 'business_hours']);
  });

  it('offers all four once the workspace has tags and fields', () => {
    expect(availableConditionTypes(VOCABULARY)).toHaveLength(4);
  });
});

describe('blankCondition', () => {
  it('seeds a contact-field condition with a field that exists', () => {
    expect(blankCondition('contact_attribute', VOCABULARY)).toStrictEqual({
      type: 'contact_attribute',
      key: FIELD.key,
      operator: 'equals',
      value: '',
    });
  });
});

describe('withOperator', () => {
  const CONDITION = {
    type: 'contact_attribute',
    key: FIELD.key,
    operator: 'equals',
    value: 'gold',
  } as const;

  it('drops the value when the operator stops comparing against one', () => {
    expect(withOperator(CONDITION, 'is_set').value).toBeNull();
  });

  it('restores an editable value when the operator starts needing one again', () => {
    const cleared = withOperator(CONDITION, 'is_set');

    expect(withOperator(cleared, 'contains').value).toBe('');
  });
});
