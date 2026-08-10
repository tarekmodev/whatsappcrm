import { z } from 'zod';

/**
 * Primitives every resource schema is built from. Defining them once is what
 * stops fifteen stories each inventing their own phone-number or money shape.
 */

/**
 * Every entity id is a UUIDv7 — time-ordered, so it doubles as a stable
 * tie-breaker for keyset pagination and keeps B-tree inserts append-mostly.
 * Validated as a plain UUID: the version nibble is an emission concern, and
 * rejecting a v4 id here would break nothing but seed data that predates it.
 */
export const IdSchema = z.uuid();

/** Timestamps cross the wire as ISO 8601 with an explicit offset, never as epoch numbers. */
export const TimestampSchema = z.iso.datetime({ offset: true });

/**
 * Phone numbers are stored and transmitted in E.164 — `+` followed by 1–15
 * digits, no spaces or punctuation. This is also the contact dedupe key, so a
 * loose format here would silently split one person into several contacts.
 */
export const PhoneE164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, 'Must be an E.164 phone number, e.g. +966501234567');

/** ISO 4217, uppercase. Always paired with an integer minor-unit amount. */
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code');

/**
 * Money is always an integer count of the currency's minor unit (825 = 8.25 USD).
 * Floating point is never used for money anywhere in this system.
 */
export const MoneySchema = z.object({
  amountMinor: z.int(),
  currency: CurrencyCodeSchema,
});

/** Hex colour, used by white-label branding. */
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a #rrggbb hex colour');

export type Id = z.infer<typeof IdSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type PhoneE164 = z.infer<typeof PhoneE164Schema>;
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;
export type Money = z.infer<typeof MoneySchema>;
