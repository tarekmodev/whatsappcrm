import type { ConfigService } from '@nestjs/config';

/**
 * The one key every stored secret in this platform is encrypted under
 * (TAR-816).
 *
 * ## Why one key, and why it was renamed
 *
 * It arrived as `WHATSAPP_TOKEN_ENCRYPTION_KEY` because the WhatsApp access
 * token was the only secret the schema held. It is not any more:
 * `platform_settings` holds the Meta app secret and the webhook verify token
 * under the same construction. A second key would mean two rotation procedures
 * and an environment that boots with WhatsApp working and platform settings
 * broken — so the key stays one and the *name* changes to match its scope.
 *
 * It is the same 32 bytes either way, so this is a configuration rename: **no
 * re-encryption, no data migration.**
 *
 * ## The transition
 *
 * `SECRETS_ENCRYPTION_KEY` is the name; `WHATSAPP_TOKEN_ENCRYPTION_KEY` is
 * accepted as a deprecated alias for one release, so a deployed environment
 * does not have to change its environment group in the same window as the code.
 * `env.schema.ts` refuses to boot when both are set to **different** values —
 * an environment where half the readers would use one key and half the other is
 * a data-loss shape, not a warning.
 *
 * Read through this function rather than `config.get` directly, so the two
 * names cannot be resolved differently in two places. The alias is deleted by
 * removing the second line below and the key from `env.schema.ts`.
 */
export function readSecretsEncryptionKey(config: ConfigService): string | undefined {
  return (
    config.get<string>('SECRETS_ENCRYPTION_KEY') ??
    config.get<string>('WHATSAPP_TOKEN_ENCRYPTION_KEY')
  );
}
