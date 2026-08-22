import { describe, expect, it } from 'vitest';
import { SLA_WINDOW_MAX_MINUTES } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import {
  describeOverrideWindows,
  describeWindow,
  parseWindow,
  toWindowInput,
  validateWindows,
} from './window-form';

/**
 * The distinction the whole form rests on: an **emptied** window is `null`, a
 * deliberate "no deadline of this kind" the contract accepts, while a value that
 * failed to parse is `undefined` and must never reach the API. A parser that
 * collapsed the two would either refuse a supervisor clearing the resolution
 * deadline, or send `NaN` as a window.
 */
describe('parseWindow', () => {
  it('reads an empty field as no deadline rather than as a bad value', () => {
    expect(parseWindow('')).toBeNull();
    expect(parseWindow('   ')).toBeNull();
  });

  it('reads a whole number of minutes', () => {
    expect(parseWindow('30')).toBe(30);
    expect(parseWindow(' 60 ')).toBe(60);
    expect(parseWindow(String(SLA_WINDOW_MAX_MINUTES))).toBe(SLA_WINDOW_MAX_MINUTES);
  });

  it('refuses what the contract refuses, so nobody round-trips to be told', () => {
    expect(parseWindow('0')).toBeUndefined();
    expect(parseWindow('-5')).toBeUndefined();
    expect(parseWindow('1.5')).toBeUndefined();
    expect(parseWindow(String(SLA_WINDOW_MAX_MINUTES + 1))).toBeUndefined();
  });

  /**
   * `Number`, not `parseInt`: the latter reads this as 30 and would save a
   * window nobody typed.
   */
  it('refuses a number with something after it', () => {
    expect(parseWindow('30abc')).toBeUndefined();
  });
});

describe('validateWindows', () => {
  it('accepts two empty fields — a policy with no deadlines is a tenant decision', () => {
    expect(validateWindows({ firstResponse: '', resolution: '' })).toStrictEqual({});
  });

  it('names each field that is wrong, not just the first', () => {
    const errors = validateWindows({ firstResponse: '0', resolution: 'soon' });

    expect(errors.firstResponse).toBeDefined();
    expect(errors.resolution).toBeDefined();
  });
});

describe('describeWindow', () => {
  it('phrases the figure, so 60 reads as the hour a supervisor is deciding about', () => {
    expect(describeWindow(60)).toBe('1 hour');
    expect(describeWindow(45)).toBe('45 minutes');
  });

  it('says there is no deadline rather than showing a blank', () => {
    expect(describeWindow(null)).toBe(content.slaSettings.windowUnset);
  });
});

describe('describeOverrideWindows', () => {
  /**
   * An override with only one of the two set is the common shape — the API
   * seeds `resolutionMinutes` null — and the line has to name both targets
   * rather than quietly dropping the one that is absent, or a supervisor reads
   * "First response 15 minutes" and assumes there is no resolution rule when
   * there might be.
   */
  it('names both targets, including the one that is not set', () => {
    expect(
      describeOverrideWindows({
        id: '0192f010-0000-7000-8000-000000001002',
        name: 'Urgent tickets',
        priority: 'urgent',
        firstResponseMinutes: 15,
        resolutionMinutes: null,
        businessHoursOnly: false,
        isActive: true,
        createdAt: '2026-07-14T08:30:00.000Z',
        updatedAt: '2026-07-14T08:30:00.000Z',
      }),
    ).toBe(`First response 15 minutes · Resolution ${content.slaSettings.windowUnset}`);
  });
});

describe('toWindowInput', () => {
  it('round-trips through the control', () => {
    expect(parseWindow(toWindowInput(30))).toBe(30);
    expect(parseWindow(toWindowInput(null))).toBeNull();
  });
});
