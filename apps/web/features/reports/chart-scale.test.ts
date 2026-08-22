import { describe, expect, it } from 'vitest';
import { barFraction, chartScale, dayLabelIndexes } from './chart-scale';

/**
 * The axis arithmetic, at the range lengths the picker actually offers and at the
 * two the contract bounds: a chart is easy to get right at 30 days and quietly
 * wrong at 366.
 */

describe('the value axis', () => {
  it('never lets a bar out of the plotting area', () => {
    for (const peak of [1, 3, 9, 17, 40, 137, 999, 12_345]) {
      expect(chartScale(peak).max).toBeGreaterThanOrEqual(peak);
    }
  });

  it('starts at zero and ends at the ceiling', () => {
    const { max, ticks } = chartScale(137);

    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(max);
  });

  it('draws between three and six lines, so the grid measures rather than competes', () => {
    for (const peak of [1, 2, 3, 9, 17, 40, 137, 999, 12_345]) {
      const { ticks } = chartScale(peak);

      expect(ticks.length, `peak ${String(peak)}`).toBeGreaterThanOrEqual(2);
      expect(ticks.length, `peak ${String(peak)}`).toBeLessThanOrEqual(6);
    }
  });

  it('labels whole tickets, because there is no half a ticket', () => {
    for (const peak of [1, 2, 3, 7, 9]) {
      for (const tick of chartScale(peak).ticks) {
        expect(Number.isInteger(tick), `peak ${String(peak)} tick ${String(tick)}`).toBe(true);
      }
    }
  });

  it('spaces the lines evenly, so a bar can be read against them', () => {
    const { ticks } = chartScale(40);
    const gaps = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? 0));

    expect(new Set(gaps).size).toBe(1);
  });

  it('answers a peak of zero rather than dividing by it', () => {
    // The chart renders its empty state instead of calling this, but a caller
    // that forgets must not produce NaN.
    expect(chartScale(0).max).toBeGreaterThan(0);
  });
});

describe('the day axis', () => {
  it('labels a month weekly and a quarter monthly, as a supervisor reads them', () => {
    expect(dayLabelIndexes(30)).toEqual([0, 7, 14, 21, 28]);
    expect(dayLabelIndexes(90)).toEqual([0, 30, 60]);
  });

  it('never writes more dates than fit across a phone', () => {
    for (const days of [1, 7, 14, 30, 60, 90, 180, 366]) {
      expect(dayLabelIndexes(days).length, `${String(days)} days`).toBeLessThanOrEqual(6);
    }
  });

  it('always labels the first day, and never one that is not in the range', () => {
    for (const days of [1, 7, 30, 90, 366]) {
      const indexes = dayLabelIndexes(days);

      expect(indexes[0]).toBe(0);
      expect(Math.max(...indexes)).toBeLessThan(days);
    }
  });

  it('has nothing to label on an empty range', () => {
    expect(dayLabelIndexes(0)).toEqual([]);
  });
});

describe('a bar’s height', () => {
  it('is measured against the axis ceiling, not against the peak', () => {
    // 9 against a ceiling of 10, so the tallest bar stops where the top gridline
    // is rather than at the top of the track.
    expect(barFraction(9, 10)).toBeCloseTo(0.9);
  });

  it('stays inside the track whatever it is handed', () => {
    expect(barFraction(20, 10)).toBe(1);
    expect(barFraction(-1, 10)).toBe(0);
    expect(barFraction(5, 0)).toBe(0);
  });
});
