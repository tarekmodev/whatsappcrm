import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/**
 * Canned responses — the tenant-shared library of standing replies an agent
 * expands in the composer by typing a shortcut (TAR-31).
 *
 * Fixed by `docs/architecture/0011-canned-responses-contract.md`, whose
 * Interfaces section this file transcribes so `apps/api` and `apps/web` validate
 * against one object rather than two readings of a markdown table.
 *
 * Two things 0011 rules on that are not visible in the shapes below:
 *
 *   * **The shortcut is resolved in the console, against the whole set**
 *     (decision 1). `GET /api/v1/canned-responses` is unpaginated and capped at
 *     {@link CANNED_RESPONSE_LIMITS.perTenant}, which is what makes "the whole
 *     set" a promise the server can keep — and what makes a per-token lookup
 *     endpoint a second reader of the same data on the keystroke path.
 *   * **Personal (per-agent) responses are out of scope at v1**, so there is no
 *     `isShared` field here. The column exists and a CHECK holds it true; the
 *     day it becomes a DTO field the *audience* changes too, from the tenant
 *     room to the owner's (0011, open question 3).
 */

/**
 * Caps the API enforces, published so the console's `maxLength` and the schema
 * that refuses the value cannot disagree. `perTenant` is what makes the
 * unpaginated list a promise the server can keep (0011, decision 1).
 */
export const CANNED_RESPONSE_LIMITS = {
  /** The whole set, shared library only at v1. */
  perTenant: 200,
  /** Including the leading `/`. */
  shortcutLength: 40,
  titleLength: 80,
  /** `SendTextInputSchema.body`'s ceiling, so an inserted body is always sendable. */
  bodyLength: 4096,
} as const;

/** The character that opens the composer's picker. One place, three readers. */
export const CANNED_RESPONSE_TRIGGER = '/';

/**
 * Lowercase, no whitespace, and no second `/` — so a shortcut can never contain
 * the trigger and a URL path segment can never be read as one. `citext` in the
 * database, so `/Hours` and `/hours` collide (0011, decision 4).
 *
 * The length cap and the grammar are two checks rather than one bounded regular
 * expression, so an over-long shortcut says "too long" instead of "malformed".
 * `canned_responses_shortcut_format` spells the same rule as
 * `^/[a-z0-9][a-z0-9_-]{0,38}$` — 40 characters including the slash, exactly
 * what `shortcutLength` publishes, so neither can accept what the other refuses.
 */
export const CannedResponseShortcutSchema = z
  .string()
  .max(CANNED_RESPONSE_LIMITS.shortcutLength)
  .regex(/^\/[a-z0-9][a-z0-9_-]*$/, 'Must start with `/`, e.g. `/hours`');

/**
 * The picker's label. Trimmed before it is measured, which is the wire schema's
 * job rather than the database's: `canned_responses_title_length` accepts
 * `'   '` because a CHECK on `trim()` would be stricter than this schema, and a
 * constraint stricter than the schema in front of it turns a `validation_failed`
 * into a 500. TAR-475's migration header flags this as TAR-477's to write.
 */
export const CannedResponseTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(CANNED_RESPONSE_LIMITS.titleLength);

/** Literal text. No interpolation at v1 (0011, non-goals). Trimmed, as the title is. */
export const CannedResponseBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(CANNED_RESPONSE_LIMITS.bodyLength);

export const CannedResponseResponseSchema = z.object({
  id: IdSchema,
  /** Unique per tenant, case-insensitively. What the agent types. */
  shortcut: CannedResponseShortcutSchema,
  /** The picker's label. Never the body — a 4 kB preview is not a menu item. */
  title: z.string().min(1).max(CANNED_RESPONSE_LIMITS.titleLength),
  /** Literal text, whole — this is what the composer inserts into the draft. */
  body: z.string().min(1).max(CANNED_RESPONSE_LIMITS.bodyLength),
  /** Null once the creator is removed from the tenant. */
  createdByUserId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const CannedResponseCreateInputSchema = z.object({
  shortcut: CannedResponseShortcutSchema,
  title: CannedResponseTitleSchema,
  body: CannedResponseBodySchema,
});

export const CannedResponseUpdateInputSchema = CannedResponseCreateInputSchema.partial();

/**
 * Unpaginated, keeping `CursorPage`'s shape so a generic list client works
 * unchanged and pagination stays addable without a breaking change.
 * `nextCursor` is always null; `perTenant` is enforced on create.
 */
export const CannedResponseListResponseSchema = z.object({
  items: z.array(CannedResponseResponseSchema),
  nextCursor: z.null(),
});

export type CannedResponseResponse = z.infer<typeof CannedResponseResponseSchema>;
export type CannedResponseCreateInput = z.infer<typeof CannedResponseCreateInputSchema>;
export type CannedResponseUpdateInput = z.infer<typeof CannedResponseUpdateInputSchema>;
export type CannedResponseListResponse = z.infer<typeof CannedResponseListResponseSchema>;
