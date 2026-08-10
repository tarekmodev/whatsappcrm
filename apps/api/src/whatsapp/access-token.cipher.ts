import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WHATSAPP_TOKEN_KEY_BYTES } from '../config/env.schema';
import {
  WhatsAppEncryptionUnavailableError,
  WhatsAppTokenUndecryptableError,
} from './whatsapp.errors';

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

/**
 * Encrypts the per-WABA access token at rest (TAR-39, security). It is the most
 * sensitive column in the schema: it authorises sending WhatsApp messages as the
 * customer's own business, so a leak is a leak of their brand rather than of
 * ours.
 *
 * ## The construction
 *
 * AES-256-GCM. Authenticated encryption, so an altered ciphertext fails to
 * decrypt rather than producing garbage that gets sent to Meta as a bearer
 * token. Chosen over AES-CBC + HMAC because it is one primitive with one key
 * instead of two of each, and over a KMS envelope because this deployment has no
 * key management service yet — see the version tag below for what makes moving
 * to one possible without a migration.
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
 * Every payload is bound to the WABA it belongs to by passing Meta's `waba_id`
 * as AAD. That closes something the encryption alone does not: anyone with write
 * access to the database — a compromised support tool, a careless backup restore
 * — could otherwise copy one tenant's ciphertext into another tenant's row and
 * have the platform send messages with a credential it was never given. With the
 * id bound in, that row simply fails to decrypt.
 *
 * ## What it deliberately does not do
 *
 *   * **No caching of plaintext.** A decrypted token exists for the duration of
 *     one call and is never held on an instance field, so it cannot outlive the
 *     request in a heap dump.
 *   * **No logging, at any level.** There is exactly one value in scope worth
 *     protecting, and every log line is a place it could go.
 *   * **No key derivation.** The configured value *is* the key — 32 bytes from a
 *     CSPRNG. Stretching a high-entropy secret buys nothing.
 */
@Injectable()
export class WhatsAppAccessTokenCipher {
  constructor(private readonly config: ConfigService) {}

  /** True when this environment can store and read tokens at all. */
  get isConfigured(): boolean {
    return this.config.get<string>('WHATSAPP_TOKEN_ENCRYPTION_KEY') !== undefined;
  }

  /**
   * `wabaId` is Meta's id for the business account this token belongs to. It is
   * the additional authenticated data — authenticated but not encrypted — and
   * the same value must be supplied on the way back out. See the note above for
   * what that binding buys.
   */
  encrypt(plaintext: string, wabaId: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv, { authTagLength: TAG_BYTES });

    cipher.setAAD(Buffer.from(wabaId, 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(SEPARATOR);
  }

  /**
   * Throws `WhatsAppTokenUndecryptableError` for anything that does not
   * authenticate: a rotated key, a truncated column, a payload moved between
   * rows, a version this build does not know.
   *
   * All of those report the same error with the same message, on purpose. A
   * caller able to tell "wrong key" from "wrong AAD" from "corrupt tag" is being
   * handed an oracle, and none of the three implies a different action for an
   * operator: re-connect the WABA.
   */
  decrypt(payload: string, wabaId: string): string {
    const parts = payload.split(SEPARATOR);

    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new WhatsAppTokenUndecryptableError(wabaId);
    }

    const [, iv, tag, ciphertext] = parts as [string, string, string, string];

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv, 'base64url'), {
        authTagLength: TAG_BYTES,
      });

      decipher.setAAD(Buffer.from(wabaId, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));

      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      // A missing key is a deployment gap and keeps its own error; everything
      // else — a bad tag, a short IV, a rotated key — is one undecryptable row.
      if (error instanceof WhatsAppEncryptionUnavailableError) {
        throw error;
      }

      throw new WhatsAppTokenUndecryptableError(wabaId);
    }
  }

  /**
   * Read per call rather than cached on the instance, so a plaintext key is not
   * resident in the provider for the lifetime of the process. `ConfigService`
   * caches the value itself; this only decides where it is held.
   */
  private key(): Buffer {
    const configured = this.config.get<string>('WHATSAPP_TOKEN_ENCRYPTION_KEY');

    if (configured === undefined) {
      throw new WhatsAppEncryptionUnavailableError();
    }

    const key = Buffer.from(configured, 'base64');

    // `env.schema.ts` already rejects a key of the wrong length at boot. Checked
    // again because this class is also constructed directly by tests and by any
    // future script, where a 16-byte key would otherwise fail inside
    // `createCipheriv` with a message naming neither the variable nor the
    // expected length.
    if (key.length !== WHATSAPP_TOKEN_KEY_BYTES) {
      throw new WhatsAppEncryptionUnavailableError();
    }

    return key;
  }
}
