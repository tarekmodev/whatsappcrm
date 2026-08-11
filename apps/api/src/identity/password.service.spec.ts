import { AUTH_POLICY } from '@whatsappcrm/contracts';
import { PasswordService } from './password.service';

/**
 * Against the real argon2id binding, not a mock. A mocked hash would assert
 * that this file calls a function, which is not the property anybody cares
 * about — and the PHC parsing below only means anything against strings the
 * binding actually produced.
 *
 * Each hash costs ~100 ms by design (19 MiB, two passes), so the suite is
 * deliberately small.
 */

const PASSWORD = 'correct horse battery staple';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  // One hash reused across the assertions that only need *a* valid hash.
  let hashed: string;

  beforeAll(async () => {
    hashed = await passwords.hash(PASSWORD);
  }, 30_000);

  it('produces a PHC string carrying the policy parameters', () => {
    // Parameters travel with the hash, which is what makes raising them a free
    // in-place upgrade rather than a migration.
    expect(hashed).toMatch(
      new RegExp(
        `^\\$argon2id\\$v=19\\$m=${AUTH_POLICY.passwordHashMemoryKib},` +
          `t=${AUTH_POLICY.passwordHashTimeCost},p=${AUTH_POLICY.passwordHashParallelism}\\$`,
      ),
    );
  });

  it('salts, so two accounts with the same password do not share a hash', async () => {
    expect(await passwords.hash(PASSWORD)).not.toBe(hashed);
  }, 30_000);

  it('verifies the right password and refuses the wrong one', async () => {
    expect(await passwords.verify(hashed, PASSWORD)).toBe(true);
    expect(await passwords.verify(hashed, `${PASSWORD} `)).toBe(false);
  }, 30_000);

  it('treats an unreadable stored hash as a failed login, not a fault', async () => {
    // A truncated or hand-edited hash makes the binding throw. The caller
    // cannot fix it, and describing the state of the account to somebody who
    // has just failed to prove they own it would be worse than a plain refusal.
    expect(await passwords.verify('not-a-phc-string', PASSWORD)).toBe(false);
  });

  describe('needsRehash', () => {
    it('leaves a hash at the current policy alone', () => {
      expect(passwords.needsRehash(hashed)).toBe(false);
    });

    it.each([
      ['weaker memory', `$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$dGFn`],
      ['fewer passes', `$argon2id$v=19$m=19456,t=1,p=1$c2FsdA$dGFn`],
    ])('upgrades a hash with %s', (_label, encoded) => {
      expect(passwords.needsRehash(encoded)).toBe(true);
    });

    it('leaves a *stronger* hash alone', () => {
      // Somebody lowering a number in AUTH_POLICY must not cause every login to
      // quietly downgrade the account it just authenticated.
      expect(passwords.needsRehash(`$argon2id$v=19$m=65536,t=4,p=1$c2FsdA$dGFn`)).toBe(false);
    });

    it.each([
      ['an empty string', ''],
      ['a bcrypt hash', '$2b$12$abcdefghijklmnopqrstuv'],
      ['a malformed parameter block', '$argon2id$v=19$m=,t=,p=$c2FsdA$dGFn'],
    ])('upgrades %s, because it was not written by this policy', (_label, encoded) => {
      expect(passwords.needsRehash(encoded)).toBe(true);
    });
  });

  it('spends comparable time on an address that has no account', async () => {
    // The point of the dummy verify. Asserted as "it does the work", not as a
    // wall-clock comparison — a timing assertion on a shared CI runner is a
    // flaky test, and the thing being protected is the absence of a shortcut.
    const started = process.hrtime.bigint();

    await passwords.verifyDummy(PASSWORD);

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // A skipped hash would return in microseconds. Ten milliseconds is far
    // below the real cost and far above "did nothing".
    expect(elapsedMs).toBeGreaterThan(10);
  }, 30_000);
});
