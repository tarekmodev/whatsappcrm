import { describe, expect, it } from 'vitest';
import { BusinessHoursSchema, isWithinBusinessHours, type BusinessHours } from './tenant';

/**
 * The predicate 0007 publishes and TAR-26 inherits, pinned at the four places
 * two implementations would disagree — and at the two daylight-saving
 * transitions 0007 leaves as an open risk and asks TAR-288 to close.
 *
 * `Europe/London` throughout, because it is the zone the risk names and its
 * transitions are an hour either side of midnight UTC, which is what makes the
 * arithmetic visible in the fixtures.
 */

const NINE_TO_FIVE: BusinessHours = { mon: [{ from: '09:00', to: '17:00' }] };

/** Friday night into Saturday morning — the interval that wraps past midnight. */
const LATE_FRIDAY: BusinessHours = { fri: [{ from: '22:00', to: '02:00' }] };

const at = (iso: string): Date => new Date(iso);

describe('isWithinBusinessHours', () => {
  describe('the interval boundaries', () => {
    // 2026-08-10 is a Monday.
    it('includes `from`', () => {
      expect(isWithinBusinessHours(NINE_TO_FIVE, 'Europe/London', at('2026-08-10T08:00:00Z'))).toBe(
        true,
      );
    });

    it('excludes `to`', () => {
      expect(isWithinBusinessHours(NINE_TO_FIVE, 'Europe/London', at('2026-08-10T16:00:00Z'))).toBe(
        false,
      );
    });

    it('excludes the minute before `from`', () => {
      expect(isWithinBusinessHours(NINE_TO_FIVE, 'Europe/London', at('2026-08-10T07:59:00Z'))).toBe(
        false,
      );
    });

    it('reads the clock in the tenant zone, not in UTC', () => {
      // 08:00 UTC is 09:00 in London (BST) and 10:00 in Berlin, so the same
      // instant is the first minute of the day in one zone and an hour into it
      // in the other. A tenant in Berlin opening at 09:00 was already open.
      expect(isWithinBusinessHours(NINE_TO_FIVE, 'Europe/Berlin', at('2026-08-10T06:00:00Z'))).toBe(
        false,
      );
      expect(isWithinBusinessHours(NINE_TO_FIVE, 'Europe/Berlin', at('2026-08-10T07:00:00Z'))).toBe(
        true,
      );
    });

    it('treats `24:00` as the end of the day rather than as midnight', () => {
      const allDay: BusinessHours = { mon: [{ from: '09:00', to: '24:00' }] };

      expect(isWithinBusinessHours(allDay, 'Europe/London', at('2026-08-10T22:59:00Z'))).toBe(true);
    });
  });

  describe('a day nobody configured', () => {
    it('is closed when the key is absent', () => {
      // 2026-08-11 is a Tuesday, and only `mon` is open.
      expect(isWithinBusinessHours(NINE_TO_FIVE, 'Europe/London', at('2026-08-11T10:00:00Z'))).toBe(
        false,
      );
    });

    it('is closed when the whole record is empty', () => {
      expect(isWithinBusinessHours({}, 'Europe/London', at('2026-08-10T10:00:00Z'))).toBe(false);
    });

    it('is closed when hours were never configured at all', () => {
      expect(isWithinBusinessHours(null, 'Europe/London', at('2026-08-10T10:00:00Z'))).toBe(false);
    });
  });

  describe('an interval that wraps past midnight', () => {
    // 2026-08-14 is a Friday; 2026-08-15 the Saturday after it.
    it('covers the evening of the day it names', () => {
      expect(isWithinBusinessHours(LATE_FRIDAY, 'Europe/London', at('2026-08-14T22:00:00Z'))).toBe(
        true,
      );
    });

    it('reaches into the following morning, which carries a different day key', () => {
      // 00:30 BST on Saturday. `sat` is absent from the record entirely, so this
      // can only be true if Friday's interval was consulted.
      expect(isWithinBusinessHours(LATE_FRIDAY, 'Europe/London', at('2026-08-14T23:30:00Z'))).toBe(
        true,
      );
    });

    it('stops at `to` on the following morning', () => {
      // 02:00 BST on Saturday — the exclusive end.
      expect(isWithinBusinessHours(LATE_FRIDAY, 'Europe/London', at('2026-08-15T01:00:00Z'))).toBe(
        false,
      );
    });

    it('does not leak into the same morning of the day it names', () => {
      // 00:30 BST on *Friday* is before the interval starts, not inside the one
      // that will start that evening. Thursday is closed, so nothing covers it.
      expect(isWithinBusinessHours(LATE_FRIDAY, 'Europe/London', at('2026-08-13T23:30:00Z'))).toBe(
        false,
      );
    });
  });

  /**
   * 0007's risk 3: "no daylight-saving edge case has been executed against a real
   * tz database", with both transitions named as TAR-288's to cover. Neither
   * needs a special case in the predicate — working from the formatted wall clock
   * is what makes them fall out — and these are what say so.
   */
  describe('across a daylight-saving transition', () => {
    /** Sunday 29 March 2026: 01:00 GMT becomes 02:00 BST, so 01:00–01:59 never happens. */
    const SPRING_FORWARD: BusinessHours = { sun: [{ from: '01:00', to: '02:00' }] };

    it('opens for no instant at all when the whole interval is inside the skipped hour', () => {
      // The last instant before the jump, the jump itself, and half an hour
      // after it. The wall clock reads 00:59, 02:00 and 02:30 — never 01:xx.
      expect(
        isWithinBusinessHours(SPRING_FORWARD, 'Europe/London', at('2026-03-29T00:59:00Z')),
      ).toBe(false);
      expect(
        isWithinBusinessHours(SPRING_FORWARD, 'Europe/London', at('2026-03-29T01:00:00Z')),
      ).toBe(false);
      expect(
        isWithinBusinessHours(SPRING_FORWARD, 'Europe/London', at('2026-03-29T01:30:00Z')),
      ).toBe(false);
    });

    it('keeps an interval spanning the gap open on both sides of it', () => {
      const spanning: BusinessHours = { sun: [{ from: '00:30', to: '03:00' }] };

      // 00:45 GMT, then 02:30 BST — the same interval, either side of an hour
      // that does not exist.
      expect(isWithinBusinessHours(spanning, 'Europe/London', at('2026-03-29T00:45:00Z'))).toBe(
        true,
      );
      expect(isWithinBusinessHours(spanning, 'Europe/London', at('2026-03-29T01:30:00Z'))).toBe(
        true,
      );
    });

    /** Sunday 25 October 2026: 02:00 BST becomes 01:00 GMT, so 01:00–01:59 happens twice. */
    it('opens for both runs of a repeated hour', () => {
      const autumnBack: BusinessHours = { sun: [{ from: '01:00', to: '02:00' }] };

      // 01:30 BST, then 01:30 GMT an hour later. Two instants, one wall clock,
      // and the tenant is open for both — which is the honest answer: the door
      // was open for two hours that morning.
      expect(isWithinBusinessHours(autumnBack, 'Europe/London', at('2026-10-25T00:30:00Z'))).toBe(
        true,
      );
      expect(isWithinBusinessHours(autumnBack, 'Europe/London', at('2026-10-25T01:30:00Z'))).toBe(
        true,
      );
      // And closed once the clock leaves it for the second time.
      expect(isWithinBusinessHours(autumnBack, 'Europe/London', at('2026-10-25T02:30:00Z'))).toBe(
        false,
      );
    });
  });

  it('refuses a zone the runtime cannot resolve rather than answering in UTC', () => {
    expect(() =>
      isWithinBusinessHours(NINE_TO_FIVE, 'Mars/Olympus_Mons', at('2026-08-10T10:00:00Z')),
    ).toThrow();
  });
});

describe('BusinessHoursSchema', () => {
  it('accepts the shape the seeded tenant carries', () => {
    expect(
      BusinessHoursSchema.parse({
        mon: [{ from: '09:00', to: '17:00' }],
        fri: [
          { from: '09:00', to: '12:00' },
          { from: '13:00', to: '17:00' },
        ],
      }),
    ).toBeDefined();
  });

  it('refuses a clock time that is not `HH:MM`', () => {
    expect(BusinessHoursSchema.safeParse({ mon: [{ from: '9:00', to: '17:00' }] }).success).toBe(
      false,
    );
    expect(BusinessHoursSchema.safeParse({ mon: [{ from: '09:00', to: '25:00' }] }).success).toBe(
      false,
    );
  });

  it('refuses a day key that is not one of the seven', () => {
    expect(
      BusinessHoursSchema.safeParse({ monday: [{ from: '09:00', to: '17:00' }] }).success,
    ).toBe(false);
  });
});
