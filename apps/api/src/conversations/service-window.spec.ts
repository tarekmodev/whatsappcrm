import { isServiceWindowOpen } from './service-window';

/**
 * The rule the send endpoint branches on. Four cases, and the two that are easy
 * to get backwards — `null`, and the boundary instant — are the ones a customer
 * feels: open when it should be closed is a message Meta refuses with an opaque
 * error, closed when it should be open is an agent forced into a template for a
 * conversation that is live.
 */

const NOW = new Date('2026-08-11T12:00:00.000Z');

describe('isServiceWindowOpen', () => {
  it('is open while the expiry is in the future', () => {
    expect(
      isServiceWindowOpen({ serviceWindowExpiresAt: new Date('2026-08-11T12:00:00.001Z') }, NOW),
    ).toBe(true);
  });

  it('is closed once the expiry has passed', () => {
    expect(
      isServiceWindowOpen({ serviceWindowExpiresAt: new Date('2026-08-11T11:59:59.999Z') }, NOW),
    ).toBe(false);
  });

  it('is closed at exactly the expiry instant', () => {
    // Exclusive, and deliberately the safe direction: our clock and Meta's do
    // not agree to the millisecond, so refusing early costs a template while
    // allowing late costs a message the customer never receives.
    expect(isServiceWindowOpen({ serviceWindowExpiresAt: NOW }, NOW)).toBe(false);
  });

  it('is closed when no window was ever opened', () => {
    // A thread opened by a delivery receipt, or by an agent reaching out first.
    // Never "unknown, allow" — that would make every such thread a failed send.
    expect(isServiceWindowOpen({ serviceWindowExpiresAt: null }, NOW)).toBe(false);
  });
});
