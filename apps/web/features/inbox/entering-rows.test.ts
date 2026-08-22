import { describe, expect, it } from 'vitest';
import { enteringIds } from './entering-rows';

const A = '0192f004-0000-7000-8000-00000000040a';
const B = '0192f004-0000-7000-8000-00000000040b';
const C = '0192f004-0000-7000-8000-00000000040c';

/**
 * TAR-517: a conversation the socket pushes into the column announces itself
 * rather than shunting the queue under the cursor. The rule that decides which
 * rows those are lives here, because the one that matters is the *negative* one
 * — a page load is not twenty-five arrivals.
 */
describe('enteringIds', () => {
  it('treats the first render as a page load, not as arrivals', () => {
    expect(enteringIds(null, [A, B])).toEqual(new Set());
  });

  it('marks only what was not there a render ago', () => {
    expect(enteringIds([B], [A, B])).toEqual(new Set([A]));
  });

  it('marks nothing when the same rows are re-rendered', () => {
    // `router.refresh()` runs on every inbox event, most of which change a row
    // rather than add one. Re-animating the column each time would be worse
    // than not animating at all.
    expect(enteringIds([A, B], [A, B])).toEqual(new Set());
  });

  it('marks nothing for a row that only moved', () => {
    // A reply moves a conversation to the top under `newest`. It is the same
    // row in a different place, and it has not arrived.
    expect(enteringIds([A, B], [B, A])).toEqual(new Set());
  });

  it('marks a row that left the filter and came back', () => {
    // Which is exactly what it is doing: arriving in this view. Comparing
    // against the previous render rather than everything ever seen is also what
    // stops the set growing for the life of the tab.
    expect(enteringIds([A], [A, C])).toEqual(new Set([C]));
    expect(enteringIds([A, C], [A])).toEqual(new Set());
    expect(enteringIds([A], [A, C])).toEqual(new Set([C]));
  });
});
