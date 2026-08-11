import { describe, expect, it } from 'vitest';
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  reconnectDelayMs,
} from './reconnect-delay';

describe('reconnectDelayMs', () => {
  it('backs off, and never below half the step it reached', () => {
    const first = reconnectDelayMs(0, 0);
    const third = reconnectDelayMs(2, 0);

    expect(first).toBe(RECONNECT_BASE_DELAY_MS / 2);
    expect(third).toBeGreaterThan(first);
  });

  it('never waits longer than the cap, however many attempts have failed', () => {
    for (const attempt of [10, 100, 1_000]) {
      expect(reconnectDelayMs(attempt, 1)).toBe(RECONNECT_MAX_DELAY_MS);
      expect(reconnectDelayMs(attempt, 0)).toBe(RECONNECT_MAX_DELAY_MS / 2);
    }
  });

  it('spreads attempts across the step, so a restart does not synchronise every tab', () => {
    const low = reconnectDelayMs(3, 0);
    const high = reconnectDelayMs(3, 1);

    expect(high).toBeGreaterThan(low);
  });

  it('treats a nonsense jitter as none rather than producing NaN', () => {
    expect(reconnectDelayMs(1, Number.NaN)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(reconnectDelayMs(1, -5)).toBe(RECONNECT_BASE_DELAY_MS);
  });
});
