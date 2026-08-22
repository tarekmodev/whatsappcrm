import { describe, expect, it } from 'vitest';
import { detailTone, readThreshold, readUsage } from './usage-reading';

/**
 * The rules two surfaces share about one number.
 *
 * `readUsage` is where "how full is this allowance" is decided once, so the
 * workspace panel and the billing page cannot disagree about whether a limit has
 * been reached. `detailTone` is the one thing that is allowed to differ between
 * them, and TAR-711 is why: the billing page carries a banner above its meters,
 * and three amber signals for two facts left nothing louder to escalate to on
 * the day a workspace actually went over.
 */

describe('readUsage', () => {
  it('treats a null ceiling as unlimited rather than as zero', () => {
    const reading = readUsage(9_999, null);

    expect(reading).toMatchObject({ cap: null, ratio: undefined, isAtCap: false, tone: 'accent' });
  });

  /** A plan downgraded below current usage is a real state, not a bug. */
  it('keeps a count that has overshot its cap at the cap', () => {
    expect(readUsage(12, 10)).toMatchObject({ isAtCap: true, tone: 'danger' });
  });

  /**
   * A cap of zero means "none of this is available", not "unlimited" — and it is
   * the value that would divide by zero.
   */
  it('reads a cap of zero as full rather than as no limit', () => {
    expect(readUsage(0, 0)).toMatchObject({ ratio: 1, isAtCap: true, tone: 'danger' });
  });

  it('warns before the cap, which is the point of a gauge', () => {
    expect(readThreshold(readUsage(8, 10))).toBe('approaching');
    expect(readThreshold(readUsage(7, 10))).toBe('under');
    expect(readThreshold(readUsage(10, 10))).toBe('reached');
  });
});

describe('detailTone', () => {
  /**
   * The case the billing page was drawing three ambers for: 5 of 6 seats and 847
   * of 1,000 conversations, with a banner already saying the second one. Both
   * meters stay neutral and the banner is the only warning on the page.
   */
  it('stays neutral while a count is merely approaching its cap', () => {
    expect(detailTone(readUsage(5, 6))).toBe('accent');
    expect(detailTone(readUsage(847, 1000))).toBe('accent');
  });

  it('escalates only once a count is genuinely at or past its cap', () => {
    expect(detailTone(readUsage(6, 6))).toBe('danger');
    expect(detailTone(readUsage(7, 6))).toBe('danger');
  });

  /** Nothing to be a proportion of, so nothing to escalate about. */
  it('stays neutral where there is no ceiling at all', () => {
    expect(detailTone(readUsage(9_999, null))).toBe('accent');
  });

  /**
   * The invariant that keeps two surfaces honest: this changes which element
   * carries the warning, never whether the limit has been reached.
   */
  it('agrees with the reading it is derived from about being at the cap', () => {
    for (const used of [0, 5, 8, 9, 10, 11]) {
      const reading = readUsage(used, 10);

      expect(detailTone(reading) === 'danger').toBe(reading.isAtCap);
    }
  });
});
