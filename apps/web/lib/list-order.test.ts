import { describe, expect, it } from 'vitest';
import { movedIds } from './list-order';

/**
 * Both surfaces that reorder — routing rules and workflows — send the tenant's
 * *complete* set, which is also the endpoint's optimistic concurrency. A move
 * that quietly returned a plausible-looking list for an id that is not in the
 * set would defeat that, so the refusals are pinned alongside the swap.
 */
describe('movedIds', () => {
  const IDS = ['a', 'b', 'c'];

  it('swaps an id past its neighbour, and returns the whole set', () => {
    expect(movedIds(IDS, 'b', 'up')).toStrictEqual(['b', 'a', 'c']);
    expect(movedIds(IDS, 'b', 'down')).toStrictEqual(['a', 'c', 'b']);
  });

  it('refuses a move off either end, so the list never sends an unchanged order', () => {
    expect(movedIds(IDS, 'a', 'up')).toBeNull();
    expect(movedIds(IDS, 'c', 'down')).toBeNull();
  });

  it('refuses to move an id that is not in the set', () => {
    expect(movedIds(IDS, 'z', 'up')).toBeNull();
  });

  it('leaves the caller’s array alone', () => {
    movedIds(IDS, 'b', 'up');

    expect(IDS).toStrictEqual(['a', 'b', 'c']);
  });
});
