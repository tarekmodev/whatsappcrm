import type { RoutingCondition } from '@whatsappcrm/contracts';
import { conditionMatches, ruleMatches } from './rule-conditions';
import type { RoutingFacts } from './routing-facts';

/**
 * The condition grammar, case by case.
 *
 * These are the cases a supervisor's rule turns on, and they are asserted
 * against plain objects rather than a database because the grammar is a pure
 * function of the facts — which is exactly why `RuleEngineService` resolves its
 * facts first and compares second.
 *
 * The property running through the whole file is 0007's: **a condition with no
 * data to read is false. It never throws and never matches.** Every source has a
 * "nothing to read" case below, including the one that is easy to get wrong — a
 * `business_hours` condition asking `within: false` of a tenant that never
 * configured hours is *false*, not true.
 */

const TAG_BILLING = '0192f0ff-0000-7000-8000-00000000t001';
const TAG_VIP = '0192f0ff-0000-7000-8000-00000000t002';

/** Everything present and empty, so each test names only what it cares about. */
function facts(overrides: Partial<RoutingFacts> = {}): RoutingFacts {
  return {
    messageBody: null,
    tagIds: null,
    customFields: null,
    withinBusinessHours: null,
    ...overrides,
  };
}

describe('keyword conditions', () => {
  const anyOf = (...values: string[]): RoutingCondition => ({
    type: 'keyword',
    match: 'any',
    values,
  });
  const allOf = (...values: string[]): RoutingCondition => ({
    type: 'keyword',
    match: 'all',
    values,
  });

  it('matches a value anywhere in the body', () => {
    expect(
      conditionMatches(anyOf('invoice'), facts({ messageBody: 'where is my invoice please' })),
    ).toBe(true);
  });

  it('ignores case on both sides', () => {
    expect(conditionMatches(anyOf('Invoice'), facts({ messageBody: 'MY INVOICE' }))).toBe(true);
  });

  it('matches inside a longer word, because "contains" has no word boundary', () => {
    // 0007 risk 4, accepted at v1: `bill` matches `billing`, and also
    // `billboard`. Asserted rather than left implicit so a later change to
    // word-boundary matching is a deliberate contract change and not a surprise.
    expect(conditionMatches(anyOf('bill'), facts({ messageBody: 'a billboard advert' }))).toBe(
      true,
    );
  });

  it('needs one value under `any` and every value under `all`', () => {
    const body = facts({ messageBody: 'billing question about my invoice' });

    expect(conditionMatches(anyOf('refund', 'invoice'), body)).toBe(true);
    expect(conditionMatches(allOf('refund', 'invoice'), body)).toBe(false);
    expect(conditionMatches(allOf('billing', 'invoice'), body)).toBe(true);
  });

  it('never matches on a value that is only whitespace', () => {
    // `''.includes('')` is true, so a blank box in the console would otherwise
    // turn a rule into "match everything" — the behaviour 0007 refuses an empty
    // `conditions` list to prevent, arriving by another door.
    expect(conditionMatches(anyOf('   '), facts({ messageBody: 'anything at all' }))).toBe(false);
    expect(conditionMatches(allOf('billing', '  '), facts({ messageBody: 'billing' }))).toBe(false);
  });

  it('is false when there is no message to read', () => {
    // A ticket created by hand (TAR-25) carries no message, and a media message
    // with no caption has a null body.
    expect(conditionMatches(anyOf('invoice'), facts({ messageBody: null }))).toBe(false);
  });
});

describe('tag conditions', () => {
  const onTags = (match: 'any' | 'all', ...tagIds: string[]): RoutingCondition => ({
    type: 'tag',
    match,
    tagIds,
  });

  it('matches a tag the contact carries', () => {
    expect(
      conditionMatches(onTags('any', TAG_BILLING), facts({ tagIds: new Set([TAG_BILLING]) })),
    ).toBe(true);
  });

  it('needs one tag under `any` and every tag under `all`', () => {
    const tagged = facts({ tagIds: new Set([TAG_BILLING]) });

    expect(conditionMatches(onTags('any', TAG_BILLING, TAG_VIP), tagged)).toBe(true);
    expect(conditionMatches(onTags('all', TAG_BILLING, TAG_VIP), tagged)).toBe(false);
  });

  it('is false for a contact with no tags, and for a ticket with no contact', () => {
    expect(conditionMatches(onTags('any', TAG_BILLING), facts({ tagIds: new Set() }))).toBe(false);
    expect(conditionMatches(onTags('any', TAG_BILLING), facts({ tagIds: null }))).toBe(false);
  });
});

describe('business-hours conditions', () => {
  const within = (value: boolean): RoutingCondition => ({ type: 'business_hours', within: value });

  it('answers the question when it can be answered', () => {
    expect(conditionMatches(within(true), facts({ withinBusinessHours: true }))).toBe(true);
    expect(conditionMatches(within(false), facts({ withinBusinessHours: true }))).toBe(false);
    expect(conditionMatches(within(false), facts({ withinBusinessHours: false }))).toBe(true);
  });

  it('is false **both ways** when the tenant has no business hours configured', () => {
    // The case 0007 decision 3 calls "refusing to guess", and the one worth a
    // test of its own: if unanswerable collapsed into `false`, the natural rule
    // "out of hours, route to the on-call team" would fire on every single
    // ticket for a tenant that never configured anything.
    expect(conditionMatches(within(false), facts({ withinBusinessHours: null }))).toBe(false);
    expect(conditionMatches(within(true), facts({ withinBusinessHours: null }))).toBe(false);
  });
});

describe('contact-attribute conditions', () => {
  const on = (
    operator: 'equals' | 'not_equals' | 'contains' | 'is_set' | 'is_not_set',
    value: string | null,
  ): RoutingCondition => ({ type: 'contact_attribute', key: 'plan', operator, value });

  const withPlan = (plan: string | null): RoutingFacts => facts({ customFields: { plan } });

  it('compares an exact value', () => {
    expect(conditionMatches(on('equals', 'gold'), withPlan('gold'))).toBe(true);
    expect(conditionMatches(on('equals', 'gold'), withPlan('silver'))).toBe(false);
    expect(conditionMatches(on('not_equals', 'gold'), withPlan('silver'))).toBe(true);
  });

  it('is case-sensitive on `equals` and case-insensitive on `contains`', () => {
    // One word, one meaning: `contains` reads the same here as it does on a
    // keyword condition. `equals` is the operator for an exact value, and a
    // supervisor picking it has asked for exactly that.
    expect(conditionMatches(on('equals', 'Gold'), withPlan('gold'))).toBe(false);
    expect(conditionMatches(on('contains', 'GOL'), withPlan('gold'))).toBe(true);
  });

  it('tells an absent field from an empty one', () => {
    expect(conditionMatches(on('is_set', null), withPlan('gold'))).toBe(true);
    expect(conditionMatches(on('is_set', null), withPlan(null))).toBe(false);
    expect(conditionMatches(on('is_not_set', null), withPlan(null))).toBe(true);
    expect(conditionMatches(on('is_not_set', null), facts({ customFields: {} }))).toBe(true);
  });

  it('refuses every comparison against a field that is not there, `not_equals` included', () => {
    // The "no data to read is false" rule, one level down. It is what keeps
    // `is_not_set` the single way to write "this field is empty" — the
    // alternative gives two spellings that agree everywhere except when the
    // contact is missing entirely, which is the worst place to differ.
    expect(conditionMatches(on('not_equals', 'gold'), withPlan(null))).toBe(false);
    expect(conditionMatches(on('equals', 'gold'), withPlan(null))).toBe(false);
    expect(conditionMatches(on('contains', 'gol'), withPlan(null))).toBe(false);
  });

  it('is false for a ticket with no contact', () => {
    expect(conditionMatches(on('is_not_set', null), facts({ customFields: null }))).toBe(false);
  });
});

describe('a rule', () => {
  const KEYWORD: RoutingCondition = { type: 'keyword', match: 'any', values: ['invoice'] };
  const TAG: RoutingCondition = { type: 'tag', match: 'any', tagIds: [TAG_VIP] };

  it('holds only when every one of its conditions holds — conditions are AND', () => {
    // Rules combine with OR by being an ordered list, which is why there is no
    // rule-level toggle: a supervisor who wants OR writes two rules.
    const both = facts({ messageBody: 'my invoice', tagIds: new Set([TAG_VIP]) });
    const keywordOnly = facts({ messageBody: 'my invoice', tagIds: new Set() });

    expect(ruleMatches([KEYWORD, TAG], both)).toBe(true);
    expect(ruleMatches([KEYWORD, TAG], keywordOnly)).toBe(false);
  });
});
