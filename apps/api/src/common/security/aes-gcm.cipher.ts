import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The AES-256-GCM construction this platform encrypts every stored secret with
 * (TAR-816, ADR-level decision recorded on TAR-811).
 *
 * It was `WhatsAppCredentialCipher` first, and only that: the per-WABA access
 * token and the per-number registration PIN. TAR-816 needs the same
 * construction for `platform_settings`, and "a second secret-storage pattern"
 * is the thing that story explicitly forbids — so the primitive moved here and
 * `WhatsAppCredentialCipher` became a named wrapper around it. The payload
 * format is byte-identical to what it was, which is what makes the extraction a
 * refactor rather than a migration: every row written before this change still
 * decrypts.
 *
 * ## The construction
 *
 * AES-256-GCM. Authenticated encryption, so an altered ciphertext fails to
 * decrypt rather than producing garbage that gets sent to Meta as a bearer
 * token. Chosen over AES-CBC + HMAC because it is one primitive with one key
 * instead of two of each, and over a KMS envelope because this deployment has
 * no key management service yet — see the version tag below for what makes
 * moving to one possible without a migration.
 *
 * Payload format, `.`-separated so it stays a single `text` column and stays
 * greppable in a database dump:
 *
 *     v1.<iv base64url>.<auth tag base64url>.<ciphertext base64url>
 *
 * `v1` is a version tag, not decoration: rotating the key or changing the
 * algorithm means old and new rows coexist for as long as re-encryption takes,
 * and a reader that cannot tell them apart has to guess.
 *
 * ## Additional authenticated data
 *
 * Every payload is bound to what it belongs to by passing an identifier as AAD.
 * That closes something the encryption alone does not: anyone with write access
 * to the database — a compromised support tool, a careless backup restore —
 * could otherwise copy one ciphertext into another row and have the platform
 * use a credential it was never given. With the identifier bound in, that row
 * simply fails to decrypt.
 *
 * What the identifier *is* belongs to the caller, because only the caller knows
 * what "another row" means for its data: `waba_id` for an access token,
 * `phone_number_id` for a registration PIN, `platform_setting:<key>` for a
 * managed platform setting.
 *
 * ## What it deliberately does not do
 *
 *   * **No caching of plaintext.** A decrypted value exists for the duration of
 *     one call and is never held on an instance field, so it cannot outlive the
 *     call in a heap dump.
 *   * **No logging, at any level.** There is exactly one value in scope worth
 *     protecting, and every log line is a place it could go.
 *   * **No key derivation.** The configured value *is* the key — 32 bytes from
 *     a CSPRNG. Stretching a high-entropy secret buys nothing.
 *   * **No Nest decorator.** It is constructed by the two classes that own a
 *     key-reading policy, not injected: a provider would make "which key" a
 *     container concern, and there is exactly one key.
 */

/** GCM's standard nonce length. 96 bits is what the mode is specified around. */
const IV_BYTES = 12;

/**
 * GCM's full-length tag, stated rather than defaulted. Node's `setAuthTag`
 * otherwise accepts a **shorter** tag for GCM, so a payload whose tag had been
 * truncated by an attacker would still authenticate — with far less work than
 * forging a full one.
 */
const TAG_BYTES = 16;

const VERSION = 'v1';
const SEPARATOR = '.';

/** The key length AES-256 requires, in bytes. */
export const AES_256_KEY_BYTES = 32;

/**
 * No key is configured, or the configured value is not 32 bytes of base64.
 *
 * Distinct from `AesGcmUndecryptableError` because the operator action differs:
 * this is a deployment gap, and every row is unreadable until it is closed.
 */
export class AesGcmKeyUnavailableError extends Error {
  constructor() {
    super('No usable AES-256 key is configured for this process.');
    this.name = 'AesGcmKeyUnavailableError';
  }
}

/**
 * A payload that does not authenticate: a rotated key, a truncated column, a
 * payload moved between rows, a version this build does not know.
 *
 * All of those report the same error with the same message, on purpose. A
 * caller able to tell "wrong key" from "wrong AAD" from "corrupt tag" is being
 * handed an oracle, and none of the three implies a different action.
 *
 * The message names neither the payload nor the value it was bound to — the
 * wrapper that owns the domain decides what is safe to name.
 */
export class AesGcmUndecryptableError extends Error {
  constructor() {
    super('The stored payload could not be decrypted.');
    this.name = 'AesGcmUndecryptableError';
  }
}

export class AesGcmCipher {
  /**
   * `readKey` is a thunk rather than a value so the plaintext key is not
   * resident on this instance for the lifetime of the process. It returns the
   * base64 form; validating it is this class's job, so the two callers cannot
   * disagree about what a usable key is.
   */
  constructor(private readonly readKey: () => string | undefined) {}

  /** True when this process can store and read encrypted values at all. */
  get isConfigured(): boolean {
    return this.readKey() !== undefined;
  }

  /**
   * `boundTo` is the additional authenticated data — authenticated but not
   * encrypted — and the same value must be supplied on the way back out. See
   * the note above for what that binding buys.
   *
   * Throws `AesGcmKeyUnavailableError` when no usable key is configured.
   */
  encrypt(plaintext: string, boundTo: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv, { authTagLength: TAG_BYTES });

    cipher.setAAD(Buffer.from(boundTo, 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(SEPARATOR);
  }

  /**
   * Throws `AesGcmUndecryptableError` for anything that does not authenticate,
   * and `AesGcmKeyUnavailableError` when there is no key to try with — the
   * second is a deployment gap and must not be reported as a bad row.
   */
  decrypt(payload: string, boundTo: string): string {
    const parts = payload.split(SEPARATOR);

    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new AesGcmUndecryptableError();
    }

    const [, iv, tag, ciphertext] = parts as [string, string, string, string];
    const key = this.key();

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
        authTagLength: TAG_BYTES,
      });

      decipher.setAAD(Buffer.from(boundTo, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));

      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // `this.key()` above is outside the `try` on purpose: a missing key is a
      // deployment gap and keeps its own error, and catching it here would
      // report every row as corrupt instead.
      throw new AesGcmUndecryptableError();
    }
  }

  /**
   * Read per call rather than cached on the instance, so a plaintext key is not
   * held for the lifetime of the process.
   *
   * `env.schema.ts` already rejects a key of the wrong length at boot. Checked
   * again here because this class is also constructed directly by tests and by
   * any future script, where a 16-byte key would otherwise fail inside
   * `createCipheriv` with a message naming neither the variable nor the
   * expected length.
   */
  private key(): Buffer {
    const configured = this.readKey();

    if (configured === undefined) {
      throw new AesGcmKeyUnavailableError();
    }

    const key = Buffer.from(configured, 'base64');

    if (key.length !== AES_256_KEY_BYTES) {
      throw new AesGcmKeyUnavailableError();
    }

    return key;
  }
}
