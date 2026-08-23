import {
  AesGcmCipher,
  AesGcmKeyUnavailableError,
  AesGcmUndecryptableError,
} from './aes-gcm.cipher';

/**
 * The properties the construction is there for, and the one property the
 * extraction had to preserve.
 *
 * `whatsapp-credential.cipher.spec.ts` already covers the same behaviour through
 * the WhatsApp wrapper and is deliberately left unmodified — that it still
 * passes is the evidence the payload format did not change. What is asserted
 * here is what only the shared class can say: the two error types the wrappers
 * translate, and that a payload written under one AAD is unreadable under
 * another regardless of which domain supplied it.
 */

/** 32 bytes, base64. A test fixture, and obviously not a key from a CSPRNG. */
const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

const PLAINTEXT = 'a-value-worth-protecting';
const AAD = 'platform_setting:whatsapp.app_secret';
const OTHER_AAD = 'platform_setting:meta.app_id';

function cipherWith(key: string | undefined): AesGcmCipher {
  return new AesGcmCipher(() => key);
}

describe('AesGcmCipher', () => {
  const cipher = cipherWith(KEY);

  it('round-trips a value', () => {
    expect(cipher.decrypt(cipher.encrypt(PLAINTEXT, AAD), AAD)).toBe(PLAINTEXT);
  });

  it('never produces the same ciphertext twice for the same input', () => {
    // A repeated IV under GCM is catastrophic, so this is not a style check.
    expect(cipher.encrypt(PLAINTEXT, AAD)).not.toBe(cipher.encrypt(PLAINTEXT, AAD));
  });

  it('does not leak the plaintext into its own ciphertext', () => {
    expect(cipher.encrypt(PLAINTEXT, AAD)).not.toContain('worth-protecting');
  });

  it('writes the version tag, so a later key rotation can tell old rows from new', () => {
    expect(cipher.encrypt(PLAINTEXT, AAD).startsWith('v1.')).toBe(true);
  });

  it('refuses a payload moved to another binding', () => {
    // The whole point of the AAD: someone with write access to the database
    // cannot copy the app secret's ciphertext into the app id's row and have the
    // platform read it back as a public value.
    const payload = cipher.encrypt(PLAINTEXT, AAD);

    expect(() => cipher.decrypt(payload, OTHER_AAD)).toThrow(AesGcmUndecryptableError);
  });

  it('refuses a payload written under another key', () => {
    const payload = cipherWith(OTHER_KEY).encrypt(PLAINTEXT, AAD);

    expect(() => cipher.decrypt(payload, AAD)).toThrow(AesGcmUndecryptableError);
  });

  it.each([
    ['a truncated payload', 'v1.abc'],
    ['a version this build does not know', 'v2.aaaa.bbbb.cccc'],
    ['something that is not a payload at all', 'not-a-payload'],
  ])('refuses %s', (_case, payload) => {
    expect(() => cipher.decrypt(payload, AAD)).toThrow(AesGcmUndecryptableError);
  });

  describe('when no usable key is configured', () => {
    it('reports the deployment gap rather than an unreadable row', () => {
      // The distinction is what lets a caller tell "this environment cannot read
      // anything" from "this one row is corrupt" — the operator actions differ,
      // and only the second one is "re-enter the value".
      const payload = cipher.encrypt(PLAINTEXT, AAD);

      expect(() => cipherWith(undefined).decrypt(payload, AAD)).toThrow(AesGcmKeyUnavailableError);
      expect(() => cipherWith(undefined).encrypt(PLAINTEXT, AAD)).toThrow(
        AesGcmKeyUnavailableError,
      );
    });

    it('reports a key of the wrong length the same way', () => {
      // `env.schema.ts` rejects this at boot, but this class is also constructed
      // directly by tests and by any future script, where `createCipheriv` would
      // otherwise fail with a message naming neither the variable nor the length.
      const short = cipherWith(Buffer.alloc(16, 7).toString('base64'));

      expect(() => short.encrypt(PLAINTEXT, AAD)).toThrow(AesGcmKeyUnavailableError);
    });

    it('says so through `isConfigured`, so a caller can refuse before trying', () => {
      expect(cipherWith(undefined).isConfigured).toBe(false);
      expect(cipher.isConfigured).toBe(true);
    });
  });
});
