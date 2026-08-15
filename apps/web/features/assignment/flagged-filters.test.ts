import { describe, expect, it } from 'vitest';
import { content } from '@/content/en';
import { deferredReasonFilters, parseDeferredReason } from './flagged-filters';

/**
 * The queue's filter is URL state, so a shared link and the back button reproduce
 * the same view — and an untrusted `?reason=` can never reach a query.
 */

describe('parseDeferredReason', () => {
  it('accepts each reason the contract publishes', () => {
    expect(parseDeferredReason('all_at_capacity')).toBe('all_at_capacity');
    expect(parseDeferredReason('none_available')).toBe('none_available');
    expect(parseDeferredReason('no_candidate_pool')).toBe('no_candidate_pool');
  });

  it('drops a value that is not a reason rather than passing it through', () => {
    expect(parseDeferredReason('everything_is_fine')).toBeUndefined();
    expect(parseDeferredReason('')).toBeUndefined();
    expect(parseDeferredReason(undefined)).toBeUndefined();
  });
});

describe('deferredReasonFilters', () => {
  it('offers a way back to every reason as the first pill', () => {
    const [first] = deferredReasonFilters(content, 'none_available');

    expect(first?.label).toBe(content.assignment.reasonFilterAll);
    expect(first?.href).toBe('/settings/assignment');
    expect(first?.isCurrent).toBe(false);
  });

  it('marks the current reason and puts every reason in the URL', () => {
    const items = deferredReasonFilters(content, 'none_available');
    const current = items.filter((item) => item.isCurrent);

    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe('none_available');
    expect(current[0]?.href).toBe('/settings/assignment?reason=none_available');
  });

  it('treats no filter as the "all reasons" pill being current', () => {
    const items = deferredReasonFilters(content, undefined);

    expect(items.filter((item) => item.isCurrent).map((item) => item.id)).toEqual(['all']);
  });

  it('labels every pill from the content layer', () => {
    const items = deferredReasonFilters(content, undefined);

    expect(items.map((item) => item.label)).toEqual([
      content.assignment.reasonFilterAll,
      content.assignment.deferredReasons.all_at_capacity,
      content.assignment.deferredReasons.none_available,
      content.assignment.deferredReasons.no_candidate_pool,
    ]);
  });
});
