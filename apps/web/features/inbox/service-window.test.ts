import { describe, expect, it } from 'vitest';
import { msUntilClose, serviceWindowAt } from './service-window';

const NOW = new Date('2026-08-12T12:00:00.000Z');

describe('serviceWindowAt', () => {
  it('is open while the expiry is still ahead', () => {
    expect(serviceWindowAt('2026-08-12T12:00:01.000Z', NOW)).toEqual({
      state: 'open',
      expiresAt: '2026-08-12T12:00:01.000Z',
    });
  });

  it('is closed once the expiry has passed', () => {
    expect(serviceWindowAt('2026-08-12T11:59:59.000Z', NOW)).toEqual({ state: 'closed' });
  });

  it('is closed exactly at the expiry, because the boundary is exclusive', () => {
    // The API refuses a send at this instant. Offering one would be a message
    // the customer never receives and a provider error nobody can read.
    expect(serviceWindowAt('2026-08-12T12:00:00.000Z', NOW)).toEqual({ state: 'closed' });
  });

  it('is closed for a thread that never had a window', () => {
    // `null` is not "unknown, allow": a conversation opened by a delivery
    // receipt, or by the team reaching out first, takes a template only.
    expect(serviceWindowAt(null, NOW)).toEqual({ state: 'closed' });
  });

  it('is closed for a timestamp it cannot read', () => {
    expect(serviceWindowAt('not a timestamp', NOW)).toEqual({ state: 'closed' });
  });
});

describe('msUntilClose', () => {
  it('measures what is left of an open window', () => {
    expect(msUntilClose(serviceWindowAt('2026-08-12T12:00:30.000Z', NOW), NOW)).toBe(30_000);
  });

  it('is zero for a closed window, so a caller cannot schedule a timer into the past', () => {
    expect(msUntilClose({ state: 'closed' }, NOW)).toBe(0);
  });
});
