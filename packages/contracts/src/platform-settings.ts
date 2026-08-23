import { z } from 'zod';
import { TimestampSchema } from './common';

/**
 * `/api/v1/admin/platform-settings` — the platform-operator surface for
 * configuration this platform used to be able to change only by redeploying
 * (TAR-816, against TAR-811's contract).
 *
 * Kept out of `admin.ts` because that file is about tenants and this is about
 * the platform's own credentials. The two share a guard and nothing else.
 *
 * ## The one property worth reading this file for
 *
 * **No shape here carries a secret's plaintext.** There is one read
 * representation, `PlatformSettingView`, and it has no variant that reveals a
 * value classified `secret` — there is no reveal endpoint and no role that
 * unlocks one. Once written, a secret's only exit from the database is into the
 * code path that uses it.
 *
 * What an operator gets instead is enough to answer the questions they actually
 * have — is it set, when did it change, who changed it, does staging hold the
 * same value — through `isSet`, `updatedAt`, `updatedByLabel`, `fingerprint`
 * and `hint`. Keys classified `public` return their plaintext, because those
 * values already reach every browser.
 */

/**
 * Whether a key's value may ever be read back.
 *
 * Code-owned in the API's registry and reported here rather than stored: the
 * console renders a secret field differently from a public one, and a row edit
 * must not be able to reclassify a secret as public.
 */
export const PLATFORM_SETTING_SENSITIVITIES = ['secret', 'public'] as const;
export const PlatformSettingSensitivitySchema = z.enum(PLATFORM_SETTING_SENSITIVITIES);
export type PlatformSettingSensitivity = (typeof PLATFORM_SETTING_SENSITIVITIES)[number];

/**
 * Where the effective value came from.
 *
 * Mandatory on every read, and the reason is an operator failure mode rather
 * than tidiness: the database **overrides** the environment, so an operator who
 * edits Render's environment group for a key that has a database row sees no
 * effect and has no way to tell why. Three distinguishable states on screen is
 * what makes that visible, and `DELETE` — "revert to environment" — is the
 * affordance that resolves it.
 */
export const PLATFORM_SETTING_SOURCES = ['database', 'environment', 'unset'] as const;
export const PlatformSettingSourceSchema = z.enum(PLATFORM_SETTING_SOURCES);
export type PlatformSettingSource = (typeof PLATFORM_SETTING_SOURCES)[number];

/**
 * A fingerprint is the first 8 hex characters of SHA-256 of the effective
 * plaintext.
 *
 * It exists so two environments can be compared — "staging and production hold
 * the same app secret" — without either of them ever returning the value. It is
 * safe to publish only because every key carries a write-time length floor: an
 * 8-hex prefix of a low-entropy value is offline-guessable.
 */
export const PlatformSettingFingerprintSchema = z.string().regex(/^[0-9a-f]{8}$/);

/**
 * The **only** shape a platform setting is ever read as. There is deliberately
 * no variant that carries a secret plaintext.
 */
export const PlatformSettingViewSchema = z.object({
  key: z.string().min(1),
  /** Shown in the admin UI. Describes the key's role, never its value. */
  description: z.string().min(1),
  sensitivity: PlatformSettingSensitivitySchema,
  source: PlatformSettingSourceSchema,
  /** `source !== 'unset'`, published so the console does not have to derive it. */
  isSet: z.boolean(),
  /**
   * The plaintext — present **only** for `sensitivity: 'public'`, and absent
   * rather than null for a secret. Absent, because `null` would read as "set to
   * nothing" beside an `isSet: true`, and the two are different facts.
   */
  value: z.string().optional(),
  /** Null when the key is unset. */
  fingerprint: PlatformSettingFingerprintSchema.nullable(),
  /**
   * The last 4 characters of the effective plaintext, and only when it is at
   * least 12 characters long — below that a suffix is a meaningful fraction of
   * the value. Null otherwise.
   *
   * It is what lets an operator confirm they pasted the right secret without
   * the API ever returning one.
   */
  hint: z.string().length(4).nullable(),
  /** Null unless `source` is `database` — the environment has no change stamp. */
  updatedAt: TimestampSchema.nullable(),
  /**
   * The label half of the operator credential that wrote the row, never the
   * secret half. Null unless `source` is `database`.
   */
  updatedByLabel: z.string().min(1).nullable(),
});

export type PlatformSettingView = z.infer<typeof PlatformSettingViewSchema>;

/**
 * `GET /api/v1/admin/platform-settings`.
 *
 * One entry per **registry** key, including the ones with no row and no
 * environment value. The registry is the list; the table is only what overrides
 * it — so a key an operator has never touched still appears, reporting
 * `source: 'unset'`, and the console does not have to know the key set to
 * render the screen.
 */
export const PlatformSettingListResponseSchema = z.object({
  settings: z.array(PlatformSettingViewSchema),
});

export type PlatformSettingListResponse = z.infer<typeof PlatformSettingListResponseSchema>;

/**
 * The key in the path.
 *
 * Shaped rather than enumerated: the allowlist of real keys lives in the API's
 * registry, is a code change to extend, and a key absent from it answers `404`.
 * Publishing the enum here would be a second copy of it that could drift, and
 * would put the platform's configuration surface into a browser bundle.
 *
 * The pattern is what the registry's own naming rule allows — dot-separated
 * lowercase segments, e.g. `whatsapp.app_secret` — so a malformed path fails
 * validation rather than reaching a lookup.
 */
export const PlatformSettingParamsSchema = z.object({
  key: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'Must be a dotted lowercase setting key'),
});

export type PlatformSettingParams = z.infer<typeof PlatformSettingParamsSchema>;

/**
 * `PUT /api/v1/admin/platform-settings/{key}`.
 *
 * The body carries the value and nothing else — not the key, which is in the
 * path, and not the sensitivity, which is the registry's to decide. The bound
 * here is a payload sanity check; the real validation is the registry's
 * per-key schema, which runs before anything is encrypted.
 */
export const SetPlatformSettingInputSchema = z.object({
  value: z.string().min(1).max(4096),
});

export type SetPlatformSettingInput = z.infer<typeof SetPlatformSettingInputSchema>;

/** What a `platform_setting_changes` row records. See the model for why `set` covers both cases. */
export const PLATFORM_SETTING_CHANGE_ACTIONS = ['set', 'cleared'] as const;
export const PlatformSettingChangeActionSchema = z.enum(PLATFORM_SETTING_CHANGE_ACTIONS);
export type PlatformSettingChangeAction = (typeof PLATFORM_SETTING_CHANGE_ACTIONS)[number];

/**
 * One entry in a key's history.
 *
 * Fingerprints and actor labels; **no values, in any form**. That is what makes
 * the history safe for anyone with admin access to read, and it is the reason
 * there is no rollback action — reverting means re-entering the value.
 */
export const PlatformSettingChangeViewSchema = z.object({
  id: z.uuid(),
  key: z.string().min(1),
  action: PlatformSettingChangeActionSchema,
  /** Null on the first `set` of a key. */
  previousFingerprint: PlatformSettingFingerprintSchema.nullable(),
  /** Null on `cleared`. */
  newFingerprint: PlatformSettingFingerprintSchema.nullable(),
  actorLabel: z.string().min(1),
  createdAt: TimestampSchema,
});

export type PlatformSettingChangeView = z.infer<typeof PlatformSettingChangeViewSchema>;

/** `GET /api/v1/admin/platform-settings/{key}/history`, newest first. */
export const PlatformSettingHistoryResponseSchema = z.object({
  changes: z.array(PlatformSettingChangeViewSchema),
});

export type PlatformSettingHistoryResponse = z.infer<typeof PlatformSettingHistoryResponseSchema>;
