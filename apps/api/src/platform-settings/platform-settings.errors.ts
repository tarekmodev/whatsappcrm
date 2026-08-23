/**
 * The failures the platform-settings write path can report (TAR-816).
 *
 * Every message here names the **key** and never the value, at any level. That
 * is the same rule `AesGcmCipher` states for itself, and it is the reason a
 * validation failure says "must be at least 32 characters" rather than echoing
 * what was sent — an error body is a place a secret ends up in a browser
 * console, a screenshot and a support ticket.
 */

/** A key that is not in `platform-settings.registry.ts`. The HTTP layer answers 404. */
export class UnknownPlatformSettingError extends Error {
  constructor(readonly key: string) {
    super(`\`${key}\` is not a managed platform setting.`);
    this.name = 'UnknownPlatformSettingError';
  }
}

/**
 * The value failed the key's registry schema.
 *
 * `reason` is the schema's own message — a rule, never a rendering of what was
 * submitted.
 */
export class PlatformSettingValueInvalidError extends Error {
  constructor(
    readonly key: string,
    readonly reason: string,
  ) {
    super(`The value for \`${key}\` is not valid: ${reason}`);
    this.name = 'PlatformSettingValueInvalidError';
  }
}

/**
 * No usable `SECRETS_ENCRYPTION_KEY` is configured, so nothing can be stored.
 *
 * Reads are unaffected — they fall back to the environment for every key, which
 * is the same fail-closed-but-still-booting shape the WhatsApp channel already
 * has. Only the write is refused, because the alternative is storing a
 * credential in clear text.
 */
export class PlatformSettingsEncryptionUnavailableError extends Error {
  constructor() {
    super(
      'Platform settings cannot be stored in this environment: SECRETS_ENCRYPTION_KEY is not ' +
        'configured. Set it (32 bytes of base64) and restart, then write the value again.',
    );
    this.name = 'PlatformSettingsEncryptionUnavailableError';
  }
}
