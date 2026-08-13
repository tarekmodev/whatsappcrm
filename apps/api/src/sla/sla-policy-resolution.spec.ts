import { resolvePolicyForPriority, type ResolvablePolicy } from './sla-policy-resolution';

/**
 * 0006 decision 6's resolution rule, which decides every ticket's deadline.
 *
 * Worth its own file because the rule is ordering, and ordering bugs are silent:
 * a ticket that quietly picks the catch-all instead of the `urgent` policy gets
 * an hour where the tenant configured fifteen minutes, and nothing anywhere says
 * so.
 */

function policy(overrides: Partial<ResolvablePolicy> & { id: string }): ResolvablePolicy {
  return {
    priority: null,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('resolvePolicyForPriority', () => {
  it('prefers a policy for the ticket’s own priority over the catch-all', () => {
    const catchAll = policy({ id: 'catch-all' });
    const urgent = policy({ id: 'urgent', priority: 'urgent' });

    expect(resolvePolicyForPriority([catchAll, urgent], 'urgent')).toBe(urgent);
  });

  it('falls back to the catch-all when no policy names the priority', () => {
    const catchAll = policy({ id: 'catch-all' });
    const urgent = policy({ id: 'urgent', priority: 'urgent' });

    expect(resolvePolicyForPriority([catchAll, urgent], 'normal')).toBe(catchAll);
  });

  /**
   * A tenant whose only policy is inactive has deliberately turned SLA off. The
   * platform default is a seed value, not a runtime fallback that would override
   * that decision.
   */
  it('answers nothing when every policy is inactive', () => {
    const disabled = policy({ id: 'disabled', isActive: false });

    expect(resolvePolicyForPriority([disabled], 'normal')).toBeNull();
  });

  it('ignores an inactive policy that would otherwise match the priority', () => {
    const catchAll = policy({ id: 'catch-all' });
    const urgent = policy({ id: 'urgent', priority: 'urgent', isActive: false });

    expect(resolvePolicyForPriority([catchAll, urgent], 'urgent')).toBe(catchAll);
  });

  /**
   * Two active policies for the same priority is a configuration a tenant can
   * reach through the API. Picking deterministically is worth more than picking
   * cleverly: the alternative is a deadline that depends on which row the
   * planner returned first.
   */
  it('breaks a tie on the oldest policy', () => {
    const older = policy({ id: 'b', createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = policy({ id: 'a', createdAt: new Date('2026-02-01T00:00:00.000Z') });

    expect(resolvePolicyForPriority([newer, older], 'normal')).toBe(older);
  });

  it('breaks a same-instant tie on the id, so the answer never depends on row order', () => {
    const first = policy({ id: 'aaa' });
    const second = policy({ id: 'bbb' });

    expect(resolvePolicyForPriority([second, first], 'normal')).toBe(first);
    expect(resolvePolicyForPriority([first, second], 'normal')).toBe(first);
  });

  it('answers nothing for a tenant with no policies at all', () => {
    expect(resolvePolicyForPriority([], 'normal')).toBeNull();
  });
});
