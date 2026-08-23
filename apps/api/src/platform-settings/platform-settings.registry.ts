import type { PlatformSettingSensitivity } from '@whatsappcrm/contracts';
import { z } from 'zod';

/**
 * The closed allowlist of configuration this platform lets an operator manage
 * at runtime (TAR-816, against TAR-811's contract).
 *
 * **This file is the enforcement mechanism.** `platform_settings` has no
 * `is_secret` column, no `visibility` column and no CHECK constraint listing the
 * keys, because all three would let a row edit reclassify a secret as public or
 * introduce a key nobody reviewed. A row whose `key` is absent from the array
 * below is ignored when the snapshot loads and logged at `warn`. Adding a
 * manageable key is therefore a code change and a code review, which is the
 * point.
 *
 * ## Resolution order, per key
 *
 * `database row → environment variable → unset`.
 *
 * Environment is the *fallback* and the database is the *override*, chosen over
 * the reverse so that shipping this changes nothing in any environment until an
 * operator writes the first row, and so environment stays the break-glass
 * channel when a row is wrong. The cost is that an operator editing an
 * environment group sees no effect on a key that has a row — paid for by
 * `source` being mandatory on every read and rendered in the admin UI.
 *
 * ## The bootstrap tier, permanently excluded
 *
 * `APP_DATABASE_URL` and `SYSTEM_DATABASE_URL` are needed to read this table;
 * `SECRETS_ENCRYPTION_KEY` is needed to decrypt it; `PLATFORM_ADMIN_TOKEN`
 * authenticates the surface that writes it, so a bad write would lock out every
 * operator with no second channel. Those, and the process-level configuration
 * beside them, must never appear here — `platform-settings.registry.spec.ts`
 * asserts it rather than leaving it to memory.
 */

/**
 * A Meta id, mirroring `MetaIdSchema` in `env.schema.ts`.
 *
 * Digits held as a string: Meta's ids exceed `Number.MAX_SAFE_INTEGER`, so a
 * value parsed as a number would silently change. Deliberately restated rather
 * than imported from the config schema — the two validate different things (a
 * boot-time environment value and an operator's paste) and coupling them would
 * make relaxing one relax the other.
 */
const MetaIdValueSchema = z.string().regex(/^\d{1,32}$/, 'Must be a Meta id (digits only)');

/**
 * The floor for a value whose fingerprint this API publishes.
 *
 * An 8-hex prefix of SHA-256 is offline-guessable for a low-entropy value.
 * `WHATSAPP_APP_SECRET` comes from Meta and is high-entropy anyway; the verify
 * token is operator-chosen and today has no floor at all, which is why one is
 * imposed here. It applies to values written through this surface — an
 * environment holding a short legacy verify token should be rotated through it.
 */
const SECRET_MIN_LENGTH = 32;

const SecretValueSchema = z
  .string()
  .min(SECRET_MIN_LENGTH, `Must be at least ${SECRET_MIN_LENGTH} characters`);

export interface PlatformSettingDefinition {
  /** Stable storage key. Never renamed — a rename orphans the row. */
  readonly key: string;
  /** The environment variable this key falls back to when no row exists. */
  readonly envVar: string;
  /**
   * `secret` is never returned in plaintext by any endpoint. `public` may be,
   * and reaches the browser. Code-owned, never a database column.
   */
  readonly sensitivity: PlatformSettingSensitivity;
  /** Validated on write, before encryption. Mirrors the `env.schema.ts` rule. */
  readonly schema: z.ZodType<string>;
  /** Shown in the admin UI. Describes the key's role, never its value. */
  readonly description: string;
}

/**
 * Phase 1 — exactly the four keys TAR-800 asked to make manageable.
 *
 * None of them changes the boot contract. The API boots today without any of
 * them and must keep doing so, so "unset" means the existing fail-closed
 * behaviour for that key, unchanged — there is no key here for which "refuse to
 * boot" would be correct.
 *
 * Deferred but needing no further architecture, to add when wanted:
 * `ANTHROPIC_API_KEY`, `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, and —
 * carefully — `META_GRAPH_API_VERSION`, which is riskier than it looks because a
 * wrong value breaks every send at once and the pin is deliberate.
 */
export const PLATFORM_SETTINGS = [
  {
    key: 'whatsapp.app_secret',
    envVar: 'WHATSAPP_APP_SECRET',
    sensitivity: 'secret',
    schema: SecretValueSchema,
    description:
      "The Meta app secret. Verifies every inbound webhook's X-Hub-Signature-256, and completes " +
      'the Embedded Signup code exchange. Unset, inbound webhooks are rejected and signup ' +
      'refuses before reaching Meta.',
  },
  {
    key: 'whatsapp.webhook_verify_token',
    envVar: 'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
    sensitivity: 'secret',
    schema: SecretValueSchema,
    description:
      "The token echoed back during Meta's GET webhook handshake, which is what registers the " +
      'webhook URL. Unset, the handshake answers 403.',
  },
  {
    key: 'meta.app_id',
    envVar: 'META_APP_ID',
    sensitivity: 'public',
    schema: MetaIdValueSchema,
    description:
      'The Meta app id. Sent as client_id on the Embedded Signup exchange and used by the ' +
      'console to launch FB.login. Not a secret — it already reaches every browser.',
  },
  {
    key: 'meta.embedded_signup_config_id',
    envVar: 'META_EMBEDDED_SIGNUP_CONFIG_ID',
    sensitivity: 'public',
    schema: MetaIdValueSchema,
    description:
      'The Facebook Login for Business configuration the console launches Embedded Signup ' +
      'with. Not a secret — it already reaches every browser.',
  },
] as const satisfies readonly PlatformSettingDefinition[];

/**
 * The union of managed keys.
 *
 * `as const satisfies` above rather than a plain type annotation is what keeps
 * these as literals: `PlatformSettingsService.get()` then rejects a mistyped key
 * at compile time, which matters most on the call sites this feature replaces —
 * `webhook-ingest.service.ts` reads one on every inbound Meta delivery, and a
 * typo there would fail closed silently.
 */
export type PlatformSettingKey = (typeof PLATFORM_SETTINGS)[number]['key'];

const BY_KEY: ReadonlyMap<string, PlatformSettingDefinition> = new Map(
  PLATFORM_SETTINGS.map((definition) => [definition.key, definition]),
);

/**
 * The definition for `key`, or `null` when it is not managed.
 *
 * `null` rather than a throw: both callers — the HTTP layer, which answers 404,
 * and the snapshot loader, which ignores the row and logs — have a specific
 * thing to do with "not in the registry", and neither is an exception.
 */
export function platformSettingDefinition(key: string): PlatformSettingDefinition | null {
  return BY_KEY.get(key) ?? null;
}
