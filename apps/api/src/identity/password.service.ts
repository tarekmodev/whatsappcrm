import { Algorithm, hash, verify } from '@node-rs/argon2';
import { Injectable, Logger } from '@nestjs/common';
import { AUTH_POLICY } from '@whatsappcrm/contracts';

/**
 * Password hashing, and the two things around it that are easy to get wrong.
 *
 * argon2id at `AUTH_POLICY`'s parameters, through `@node-rs/argon2`: a prebuilt
 * native binding, so the runtime image needs no compiler, and native, so the
 * hash does not occupy the JavaScript thread. Never bcrypt — it silently
 * truncates at 72 bytes, which turns a long passphrase into a shorter secret
 * than the user believes they chose.
 *
 * Two behaviours here are security properties rather than conveniences:
 *
 *   * **`verifyDummy`.** Login must spend comparable time whether or not the
 *     address exists. Without it, response time separates "no such user" from
 *     "wrong password" and the endpoint becomes a user-enumeration oracle that
 *     no amount of identical response bodies can close.
 *   * **`needsRehash`.** Parameters are stored inside the PHC string, so raising
 *     them in `AUTH_POLICY` upgrades every account for free — on the next
 *     successful login, where the plaintext is briefly in hand. Without this,
 *     raising them protects only accounts created afterwards.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: AUTH_POLICY.passwordHashMemoryKib,
  timeCost: AUTH_POLICY.passwordHashTimeCost,
  parallelism: AUTH_POLICY.passwordHashParallelism,
} as const;

/**
 * Hashed once, lazily, and reused: the dummy exists to burn the same CPU a real
 * verify would, and re-deriving it per request would double that cost for no
 * gain. Its plaintext is a constant nobody can log in with — `password_hash` is
 * never null-checked against it, and no `users` row ever holds it.
 */
const DUMMY_PLAINTEXT = 'argon2id-dummy-verify-target-not-a-credential';

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  /** Memoised promise, not a value: concurrent first logins share one hash. */
  private dummyHash: Promise<string> | null = null;

  /** Returns the PHC-encoded hash. The plaintext is never retained or logged. */
  async hash(plaintext: string): Promise<string> {
    return await hash(plaintext, ARGON2_OPTIONS);
  }

  /**
   * Whether `plaintext` produced `encoded`.
   *
   * A malformed or truncated stored hash makes the binding throw. That is a
   * failed authentication, not a 500 — the caller cannot fix it and telling
   * them anything more would describe the state of an account to somebody who
   * has just failed to prove they own it — so it is logged with the reason and
   * answered `false`.
   */
  async verify(encoded: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(encoded, plaintext, ARGON2_OPTIONS);
    } catch (error: unknown) {
      this.logger.error(
        `Stored password hash could not be verified and was treated as a failure: ${describe(error)}`,
      );
      return false;
    }
  }

  /**
   * Burns a verify's worth of CPU against a fixed hash and discards the answer.
   *
   * Called on every login that has no password to check — unknown address, an
   * invited account that has not set one, a suspended or removed user — so all
   * four take the same time as a wrong password.
   */
  async verifyDummy(plaintext: string): Promise<void> {
    await this.verify(await this.dummy(), plaintext);
  }

  /**
   * True when `encoded` was produced with parameters weaker than the current
   * policy, so the caller can re-hash inside the transaction that already has
   * the plaintext.
   *
   * Only ever upgrades. A hash that is *stronger* than the policy — because
   * someone lowered a number — is left alone: re-hashing it would quietly
   * weaken an account, which is not something a login should do on its own
   * initiative.
   */
  needsRehash(encoded: string): boolean {
    const parameters = parsePhcParameters(encoded);

    if (parameters === null) {
      // Unparseable means it was not written by this code path. Re-hashing on
      // the next successful login is the migration, so say yes.
      return true;
    }

    return (
      parameters.m < ARGON2_OPTIONS.memoryCost ||
      parameters.t < ARGON2_OPTIONS.timeCost ||
      parameters.p < ARGON2_OPTIONS.parallelism
    );
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= this.hash(DUMMY_PLAINTEXT);

    return this.dummyHash;
  }
}

interface Argon2Parameters {
  m: number;
  t: number;
  p: number;
}

/**
 * Pulls `m`, `t` and `p` out of a PHC string
 * (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>`).
 *
 * Hand-parsed rather than reached for through the binding because the binding
 * exposes no such call, and because the alternative — storing the parameters in
 * a second column — is two sources of truth for one fact.
 */
function parsePhcParameters(encoded: string): Argon2Parameters | null {
  const fields = encoded.split('$');
  // ['', 'argon2id', 'v=19', 'm=…,t=…,p=…', salt, tag]
  const parameters = fields[3];

  if (fields[1] !== 'argon2id' || parameters === undefined) {
    return null;
  }

  const values = new Map(
    parameters.split(',').map((pair) => {
      const [key, value] = pair.split('=');

      return [key, Number(value)] as const;
    }),
  );

  const m = values.get('m');
  const t = values.get('t');
  const p = values.get('p');

  return m !== undefined && t !== undefined && p !== undefined && ![m, t, p].some(Number.isNaN)
    ? { m, t, p }
    : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
