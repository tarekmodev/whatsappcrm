import type { ConfigService } from '@nestjs/config';
import { WhatsAppAccessTokenCipher } from './access-token.cipher';
import {
  WhatsAppEncryptionUnavailableError,
  WhatsAppTokenUndecryptableError,
} from './whatsapp.errors';

/**
 * The properties the encryption is there for, not the fact that it round-trips.
 * The two that carry weight are the AAD binding — which is what stops a
 * ciphertext being moved between tenants' rows — and failing closed when no key
 * is configured.
 */

/** 32 bytes, base64. A test fixture, and obviously not a key from a CSPRNG. */
const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

const WABA_ID = '102290129340398';
const OTHER_WABA_ID = '987654321098765';
const TOKEN = 'EAAG...a-meta-access-token-shaped-string';

function cipherWith(key: string | undefined): WhatsAppAccessTokenCipher {
  const config = {
    get: (name: string) => (name === 'WHATSAPP_TOKEN_ENCRYPTION_KEY' ? key : undefined),
  } as unknown as ConfigService;

  return new WhatsAppAccessTokenCipher(config);
}

describe('WhatsAppAccessTokenCipher', () => {
  const cipher = cipherWith(KEY);

  it('round-trips a token', () => {
    expect(cipher.decrypt(cipher.encrypt(TOKEN, WABA_ID), WABA_ID)).toBe(TOKEN);
  });

  it('never produces the same ciphertext twice for the same input', () => {
    // A repeated IV under GCM is catastrophic, so this is not a style check.
    expect(cipher.encrypt(TOKEN, WABA_ID)).not.toBe(cipher.encrypt(TOKEN, WABA_ID));
  });

  it('does not leak the token into its own ciphertext', () => {
    expect(cipher.encrypt(TOKEN, WABA_ID)).not.toContain('EAAG');
  });

  it('refuses a payload moved to another WABA row', () => {
    // The whole point of binding the WABA id in as AAD: someone with write
    // access to the database cannot copy one tenant's credential into another
    // tenant's row and have the platform send with it.
    const payload = cipher.encrypt(TOKEN, WABA_ID);

    expect(() => cipher.decrypt(payload, OTHER_WABA_ID)).toThrow(WhatsAppTokenUndecryptableError);
  });

  it('refuses a payload encrypted under a different key', () => {
    const payload = cipherWith(OTHER_KEY).encrypt(TOKEN, WABA_ID);

    expect(() => cipher.decrypt(payload, WABA_ID)).toThrow(WhatsAppTokenUndecryptableError);
  });

  it('refuses a ciphertext whose bytes have been altered', () => {
    const [version, iv, tag, ciphertext] = cipher.encrypt(TOKEN, WABA_ID).split('.');
    const altered = Buffer.from(ciphertext ?? '', 'base64url');
    altered[0] = (altered[0] ?? 0) ^ 0xff;

    expect(() =>
      cipher.decrypt([version, iv, tag, altered.toString('base64url')].join('.'), WABA_ID),
    ).toThrow(WhatsAppTokenUndecryptableError);
  });

  it('refuses a truncated authentication tag', () => {
    // Node accepts a short GCM tag unless `authTagLength` is stated, and a
    // 4-byte tag is forgeable by brute force. This asserts it is stated.
    const [version, iv, tag, ciphertext] = cipher.encrypt(TOKEN, WABA_ID).split('.');
    const short = Buffer.from(tag ?? '', 'base64url').subarray(0, 4);

    expect(() =>
      cipher.decrypt([version, iv, short.toString('base64url'), ciphertext].join('.'), WABA_ID),
    ).toThrow(WhatsAppTokenUndecryptableError);
  });

  it.each([
    ['a payload with too few parts', 'v1.only-two'],
    ['a payload from a version this build does not know', 'v2.aaaa.bbbb.cccc'],
    ['an empty payload', ''],
  ])('refuses %s', (_case, payload) => {
    expect(() => cipher.decrypt(payload, WABA_ID)).toThrow(WhatsAppTokenUndecryptableError);
  });

  describe('when no key is configured', () => {
    const unconfigured = cipherWith(undefined);

    it('reports the channel as unavailable rather than defaulting to anything', () => {
      expect(unconfigured.isConfigured).toBe(false);
    });

    it('refuses to store a token in clear text', () => {
      expect(() => unconfigured.encrypt(TOKEN, WABA_ID)).toThrow(
        WhatsAppEncryptionUnavailableError,
      );
    });

    it('refuses to read one', () => {
      const payload = cipher.encrypt(TOKEN, WABA_ID);

      expect(() => unconfigured.decrypt(payload, WABA_ID)).toThrow(
        WhatsAppEncryptionUnavailableError,
      );
    });
  });

  it('refuses a key of the wrong length rather than failing inside the crypto call', () => {
    const tooShort = cipherWith(Buffer.alloc(16, 1).toString('base64'));

    expect(() => tooShort.encrypt(TOKEN, WABA_ID)).toThrow(WhatsAppEncryptionUnavailableError);
  });
});
