import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AesGcmCipher,
  AesGcmKeyUnavailableError,
  AesGcmUndecryptableError,
} from '../common/security/aes-gcm.cipher';
import { readSecretsEncryptionKey } from '../common/security/secrets-encryption-key';
import {
  WhatsAppEncryptionUnavailableError,
  WhatsAppTokenUndecryptableError,
} from './whatsapp.errors';

/**
 * Encrypts the WhatsApp channel's stored credentials at rest (TAR-39,
 * security): the per-WABA access token, which authorises sending messages as
 * the customer's own business, and the per-number registration PIN (TAR-170),
 * which is what re-registering a number for sending needs. Both are secrets
 * this platform holds on a customer's behalf, and a leak of either is a leak of
 * their brand rather than of ours.
 *
 * ## What this class is, since TAR-816
 *
 * A **named wrapper**. The AES-256-GCM construction, the payload format, the
 * key-length check and the version tag all moved to `AesGcmCipher` in
 * `common/security/`, because `platform_settings` needs the identical
 * construction and a second implementation of it would be a second thing to
 * review, rotate and get wrong. The payload format is byte-identical to what it
 * was, so every row written before that extraction still decrypts.
 *
 * What stayed here is everything that is about *this domain* rather than about
 * the cipher, and it is not nothing:
 *
 *   * **The AAD contract.** Every payload is bound to the row it belongs to by
 *     that row's Meta id — `waba_id` for an access token, `phone_number_id` for
 *     a registration PIN. That is what stops someone with write access to the
 *     database copying one tenant's ciphertext into another tenant's row and
 *     having the platform send messages with a credential it was never given.
 *     The binding is per **row**, not per business account, which is why the
 *     parameter is `boundTo` rather than a WABA id: two numbers under one WABA
 *     are registered independently and hold independent PINs, so a PIN moved
 *     between them must fail to decrypt just as a token moved between tenants
 *     does.
 *   * **The errors.** `WhatsAppEncryptionUnavailableError` names the missing
 *     configuration to an operator and `WhatsAppTokenUndecryptableError` names
 *     the row, and both are what `whatsapp.errors.ts` maps onto the published
 *     failure taxonomy. The shared cipher deliberately knows about neither.
 *
 * Which key it reads is `readSecretsEncryptionKey`'s decision, not this class's
 * — see that file for why the variable was renamed and what the deprecated
 * alias is.
 */
@Injectable()
export class WhatsAppCredentialCipher {
  private readonly cipher: AesGcmCipher;

  constructor(private readonly config: ConfigService) {
    this.cipher = new AesGcmCipher(() => readSecretsEncryptionKey(this.config));
  }

  /** True when this environment can store and read credentials at all. */
  get isConfigured(): boolean {
    return this.cipher.isConfigured;
  }

  /**
   * `boundTo` is Meta's id for the row this credential belongs to — `waba_id`
   * for an access token, `phone_number_id` for a registration PIN. It is the
   * additional authenticated data — authenticated but not encrypted — and the
   * same value must be supplied on the way back out.
   */
  encrypt(plaintext: string, boundTo: string): string {
    try {
      return this.cipher.encrypt(plaintext, boundTo);
    } catch (error: unknown) {
      throw translate(error, boundTo);
    }
  }

  /**
   * Throws `WhatsAppTokenUndecryptableError` for anything that does not
   * authenticate: a rotated key, a truncated column, a payload moved between
   * rows, a version this build does not know.
   *
   * All of those report the same error with the same message, on purpose. A
   * caller able to tell "wrong key" from "wrong AAD" from "corrupt tag" is
   * being handed an oracle, and none of the three implies a different action
   * for an operator: re-connect the WABA.
   */
  decrypt(payload: string, boundTo: string): string {
    try {
      return this.cipher.decrypt(payload, boundTo);
    } catch (error: unknown) {
      throw translate(error, boundTo);
    }
  }
}

/**
 * The shared cipher's two failures, in this domain's vocabulary.
 *
 * A missing key is a deployment gap and keeps its own error; an unauthenticated
 * payload is one unreadable row. Anything else is a fault and is rethrown
 * unchanged rather than being flattened into "undecryptable", which would hide
 * a bug behind an operator-facing message.
 */
function translate(error: unknown, boundTo: string): unknown {
  if (error instanceof AesGcmKeyUnavailableError) {
    return new WhatsAppEncryptionUnavailableError();
  }

  if (error instanceof AesGcmUndecryptableError) {
    return new WhatsAppTokenUndecryptableError(boundTo);
  }

  return error;
}
