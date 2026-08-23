import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import type { AuditService } from '../audit/audit.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { WhatsAppCredentialCipher } from './whatsapp-credential.cipher';
import type { MetaCloudApiClient } from './meta-cloud-api.client';
import {
  MetaAuthenticationError,
  MetaRateLimitedError,
  MetaRequestRejectedError,
  MetaUnavailableError,
} from './meta-cloud-api.errors';
import { WhatsAppPhoneNumberRegistrationService } from './phone-number-registration.service';
import type { WhatsAppCredentialResolver } from './whatsapp-credential.resolver';
import { WhatsAppAccountNotFoundError, WhatsAppTokenUndecryptableError } from './whatsapp.errors';

/**
 * What registering a number composes, with no database and no Meta in the way.
 *
 * Three properties carry the weight here, and each of them is a bug somebody
 * would otherwise find in production:
 *
 *   * **The PIN is reused, never regenerated.** A registration that succeeded
 *     and whose outcome write was then lost leaves Meta holding a PIN only this
 *     column has; a retry with a fresh one would be refused forever.
 *   * **The stored PIN never leaves.** Not in a response, not in a log line, not
 *     in an audit row.
 *   * **A slow attempt cannot downgrade a `registered` row.** The compare-and-set
 *     on `pending` is the whole defence, and a mock is the only place a lost race
 *     can be reproduced deliberately.
 */

const ACCOUNT_ID = '70444444-4444-7444-8444-444444444401';
const PHONE_NUMBER_ID = '15550001111';
const WABA_ID = '102290129340398';
const ACCESS_TOKEN = 'EAAG-a-business-integration-system-user-token';
const STORED_PIN = '042042';
const ENCRYPTED_PIN = 'v1.aaa.bbb.ccc';
const GRAPH_TIMEOUT_MS = 10_000;
const NOW = new Date('2026-08-23T09:00:00.000Z');

interface AccountRow {
  id: string;
  phoneNumberId: string;
  registrationStatus: 'unregistered' | 'pending' | 'registered' | 'failed';
  registrationPinEncrypted: string | null;
  registrationFailureReason: string | null;
  registeredAt: Date | null;
  registrationAttemptedAt: Date | null;
  whatsappBusinessAccount: { wabaId: string };
}

function row(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: ACCOUNT_ID,
    phoneNumberId: PHONE_NUMBER_ID,
    registrationStatus: 'unregistered',
    registrationPinEncrypted: null,
    registrationFailureReason: null,
    registeredAt: null,
    registrationAttemptedAt: null,
    whatsappBusinessAccount: { wabaId: WABA_ID },
    ...overrides,
  };
}

function metaRejects(): MetaRequestRejectedError {
  return new MetaRequestRejectedError(400, {
    code: 133_016,
    subcode: null,
    message: 'Meta said something only an operator can act on',
    traceId: 'Az8-a-trace-id',
  });
}

interface TransactionSpies {
  $executeRaw: jest.Mock;
  whatsappAccount: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
}

/** Only the fields these assertions read. */
interface UpdateArgs {
  where?: Record<string, unknown>;
  data: Record<string, unknown>;
}

describe('WhatsAppPhoneNumberRegistrationService', () => {
  let tx: TransactionSpies;
  let cipher: { encrypt: jest.Mock; decrypt: jest.Mock };
  let registerPhoneNumber: jest.Mock;
  let forPhoneNumber: jest.Mock;
  let record: jest.Mock;
  let service: WhatsAppPhoneNumberRegistrationService;
  let warn: jest.SpyInstance;

  /** Whatever the row reads as *after* the outcome was written. */
  function settledAs(overrides: Partial<AccountRow>): void {
    tx.whatsappAccount.findUniqueOrThrow.mockResolvedValue(row(overrides));
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);

    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      whatsappAccount: {
        findUnique: jest.fn().mockResolvedValue(row()),
        findUniqueOrThrow: jest.fn().mockResolvedValue(
          row({
            registrationStatus: 'registered',
            registeredAt: NOW,
            registrationAttemptedAt: NOW,
          }),
        ),
        update: jest.fn().mockResolvedValue({ id: ACCOUNT_ID }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const prisma = {
      $tenantTransaction: jest.fn(async (work: (client: TransactionSpies) => Promise<unknown>) =>
        work(tx),
      ),
    } as unknown as TenantPrisma;

    cipher = {
      encrypt: jest.fn().mockReturnValue(ENCRYPTED_PIN),
      decrypt: jest.fn().mockReturnValue(STORED_PIN),
    };
    registerPhoneNumber = jest.fn().mockResolvedValue(undefined);
    forPhoneNumber = jest.fn().mockResolvedValue({
      whatsappBusinessAccountId: '60444444-4444-7444-8444-444444444401',
      wabaId: WABA_ID,
      accessToken: ACCESS_TOKEN,
      whatsappAccountId: ACCOUNT_ID,
      phoneNumberId: PHONE_NUMBER_ID,
    });
    record = jest.fn().mockResolvedValue(undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    service = new WhatsAppPhoneNumberRegistrationService(
      prisma,
      { getOrThrow: () => GRAPH_TIMEOUT_MS } as unknown as ConfigService,
      cipher as unknown as WhatsAppCredentialCipher,
      { forPhoneNumber } as unknown as WhatsAppCredentialResolver,
      { registerPhoneNumber } as unknown as MetaCloudApiClient,
      { record } as unknown as AuditService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
  });

  function retry() {
    return service.register({ whatsappAccountId: ACCOUNT_ID, attempt: 'retry' });
  }

  /** The `where`/`data` of the first `update`/`updateMany` call. */
  function updateArgs(spy: jest.Mock): UpdateArgs {
    const [call] = spy.mock.calls as [UpdateArgs][];

    if (call === undefined) {
      throw new Error('the spy was never called');
    }

    return call[0];
  }

  function auditedEntry(): {
    action: string;
    targetType: string;
    targetId: string;
    metadata: Record<string, unknown>;
  } {
    const [call] = record.mock.calls as [
      unknown,
      { action: string; targetType: string; targetId: string; metadata: Record<string, unknown> },
    ][];

    if (call === undefined) {
      throw new Error('the spy was never called');
    }

    return call[1];
  }

  function auditedMetadata(): Record<string, unknown> {
    return auditedEntry().metadata;
  }

  /** Every line the service warned about, as text. */
  function warned(): string {
    return (warn.mock.calls as unknown[][]).map((call) => String(call[0])).join('\n');
  }

  /** What the last attempt sent Meta. */
  function registered(): { pin: string; accessToken: string; phoneNumberId: string } {
    const [call] = registerPhoneNumber.mock.calls as [
      { pin: string; accessToken: string; phoneNumberId: string },
    ][];

    if (call === undefined) {
      throw new Error('the spy was never called');
    }

    return call[0];
  }

  describe('the PIN', () => {
    it('generates six digits and stores them encrypted when the number has none', async () => {
      await retry();

      const { pin } = registered();

      expect(pin).toMatch(/^\d{6}$/);
      // Bound to the number, not the WABA: two numbers under one business
      // account are registered independently and must not share a ciphertext.
      expect(cipher.encrypt).toHaveBeenCalledWith(pin, PHONE_NUMBER_ID);
      expect(registerPhoneNumber).toHaveBeenCalledWith({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: ACCESS_TOKEN,
        pin,
      });
    });

    it('reuses the stored PIN rather than generating a second one', async () => {
      // The requirement the whole retry story rests on. A number Meta accepted
      // under a PIN this platform then replaced could never be re-registered.
      tx.whatsappAccount.findUnique.mockResolvedValue(
        row({ registrationStatus: 'failed', registrationPinEncrypted: ENCRYPTED_PIN }),
      );

      await retry();

      expect(cipher.decrypt).toHaveBeenCalledWith(ENCRYPTED_PIN, PHONE_NUMBER_ID);
      expect(registerPhoneNumber).toHaveBeenCalledWith(
        expect.objectContaining({ pin: STORED_PIN }),
      );
    });

    it('registers with a fresh PIN when the stored one will not decrypt', async () => {
      // A rotated key. `WhatsAppTokenUndecryptableError` tells an operator to
      // re-connect the business account, which is the repair for the *token* and
      // not for this — so it is caught rather than surfaced.
      tx.whatsappAccount.findUnique.mockResolvedValue(
        row({ registrationPinEncrypted: 'v1.rotated.key.ciphertext' }),
      );
      cipher.decrypt.mockImplementation(() => {
        throw new WhatsAppTokenUndecryptableError(PHONE_NUMBER_ID);
      });

      await retry();

      const { pin } = registered();

      expect(pin).toMatch(/^\d{6}$/);
      expect(pin).not.toBe(STORED_PIN);
      expect(warned()).toContain(PHONE_NUMBER_ID);
    });

    it('never puts the PIN in an audit row, a response or a log line', async () => {
      tx.whatsappAccount.findUnique.mockResolvedValue(
        row({ registrationPinEncrypted: ENCRYPTED_PIN }),
      );
      registerPhoneNumber.mockRejectedValue(metaRejects());
      settledAs({ registrationStatus: 'failed', registrationFailureReason: 'rejected' });

      const state = await retry();

      const written = [JSON.stringify(auditedMetadata()), JSON.stringify(state), warned()].join(
        '\n',
      );

      expect(written).not.toContain(STORED_PIN);
      expect(written).not.toContain(ENCRYPTED_PIN);
    });
  });

  describe('claiming the row', () => {
    it('takes a lock in its own namespace, so it cannot collide with the connection lock', async () => {
      await retry();

      const [lockCall] = tx.$executeRaw.mock.calls as [unknown, string][];

      expect(lockCall?.[1]).toBe(`whatsapp-registration:${ACCOUNT_ID}`);
    });

    it('marks the row pending before Meta is called, and commits before calling it', async () => {
      // The PIN has to be durable *before* it reaches Meta: a register that
      // succeeded against a transaction that then rolled back would strand a
      // secret on Meta's side that this platform cannot reproduce.
      await retry();

      expect(updateArgs(tx.whatsappAccount.update).data).toMatchObject({
        registrationStatus: 'pending',
        registrationAttemptedAt: NOW,
        registrationPinEncrypted: ENCRYPTED_PIN,
      });
      expect(tx.whatsappAccount.update.mock.invocationCallOrder[0]).toBeLessThan(
        registerPhoneNumber.mock.invocationCallOrder[0] as number,
      );
    });

    it('is a no-op on a number that already reads registered', async () => {
      tx.whatsappAccount.findUnique.mockResolvedValue(
        row({ registrationStatus: 'registered', registeredAt: NOW, registrationAttemptedAt: NOW }),
      );

      const state = await retry();

      // "Already registered" is the outcome the caller wanted, so it is reported
      // as state rather than as an error — and Meta is not touched at all.
      expect(registerPhoneNumber).not.toHaveBeenCalled();
      expect(tx.whatsappAccount.update).not.toHaveBeenCalled();
      expect(state).toMatchObject({ registrationStatus: 'registered', registeredAt: NOW });
    });

    it('leaves an attempt that is genuinely still in flight alone', async () => {
      tx.whatsappAccount.findUnique.mockResolvedValue(
        row({
          registrationStatus: 'pending',
          registrationAttemptedAt: new Date(NOW.getTime() - GRAPH_TIMEOUT_MS + 1_000),
        }),
      );

      const state = await retry();

      expect(registerPhoneNumber).not.toHaveBeenCalled();
      expect(state.registrationStatus).toBe('pending');
    });

    it('takes over a pending row whose attempt outlived the Graph timeout', async () => {
      // A process killed between the Meta call and the outcome write. Nothing
      // can still be waiting on Meta past its own timeout.
      tx.whatsappAccount.findUnique.mockResolvedValue(
        row({
          registrationStatus: 'pending',
          registrationAttemptedAt: new Date(NOW.getTime() - GRAPH_TIMEOUT_MS - 1),
          registrationPinEncrypted: ENCRYPTED_PIN,
        }),
      );

      await retry();

      expect(registerPhoneNumber).toHaveBeenCalledWith(
        expect.objectContaining({ pin: STORED_PIN }),
      );
    });

    it('reports an id that names nothing reachable as absent', async () => {
      // Under RLS another tenant's number is indistinguishable from one that
      // does not exist, and it has to stay that way.
      tx.whatsappAccount.findUnique.mockResolvedValue(null);

      await expect(retry()).rejects.toBeInstanceOf(WhatsAppAccountNotFoundError);
    });
  });

  describe('recording the outcome', () => {
    it('writes registered and audits the success', async () => {
      await retry();

      expect(updateArgs(tx.whatsappAccount.updateMany).data).toEqual({
        registrationStatus: 'registered',
        registeredAt: NOW,
        registrationFailureReason: null,
      });
      expect(auditedEntry()).toMatchObject({
        action: AUDIT_ACTIONS.whatsappPhoneNumberRegistered,
        targetType: 'whatsapp_account',
        targetId: ACCOUNT_ID,
      });
    });

    it.each([
      ['a rejected credential', new MetaAuthenticationError(401, null), 'credential_rejected'],
      ['throttling', new MetaRateLimitedError(429, null, 30), 'rate_limited'],
      ['an outage', new MetaUnavailableError(503, null, 'HTTP 503'), 'upstream_unavailable'],
      ['a refusal this build does not model', metaRejects(), 'rejected'],
    ])('reports %s as %s', async (_case, thrown, reason) => {
      registerPhoneNumber.mockRejectedValue(thrown);
      settledAs({ registrationStatus: 'failed', registrationFailureReason: reason });

      const state = await retry();

      expect(updateArgs(tx.whatsappAccount.updateMany).data).toEqual({
        registrationStatus: 'failed',
        registrationFailureReason: reason,
      });
      expect(state.registrationFailureReason).toBe(reason);
      expect(auditedEntry()).toMatchObject({
        action: AUDIT_ACTIONS.whatsappPhoneNumberRegistrationFailed,
      });
    });

    it('audits Meta’s code and trace id, and nothing else Meta said', async () => {
      registerPhoneNumber.mockRejectedValue(metaRejects());
      settledAs({ registrationStatus: 'failed', registrationFailureReason: 'rejected' });

      await retry();

      expect(auditedMetadata()).toEqual({
        phoneNumberId: PHONE_NUMBER_ID,
        wabaId: WABA_ID,
        attempt: 'retry',
        reason: 'rejected',
        metaCode: 133_016,
        metaTraceId: 'Az8-a-trace-id',
      });
      // Meta's free-text message describes this app's grant and configuration,
      // and this table is exported for compliance review.
      expect(JSON.stringify(auditedMetadata())).not.toContain('only an operator');
    });

    it('writes the outcome only while the row still reads pending', async () => {
      await retry();

      expect(updateArgs(tx.whatsappAccount.updateMany).where).toEqual({
        id: ACCOUNT_ID,
        registrationStatus: 'pending',
      });
    });

    it('never downgrades a registered row when it loses the race', async () => {
      // Another attempt took the row over and finished first. The compare-and-set
      // matches nothing, so the loser's failure is audited and discarded.
      registerPhoneNumber.mockRejectedValue(metaRejects());
      tx.whatsappAccount.updateMany.mockResolvedValue({ count: 0 });
      settledAs({ registrationStatus: 'registered', registeredAt: NOW });

      const state = await retry();

      expect(state.registrationStatus).toBe('registered');
      expect(record).toHaveBeenCalledTimes(1);
    });

    it('reports a stored reason this build does not model as rejected', async () => {
      // What a rollback across an addition to the vocabulary looks like. The
      // console keeps six exhaustive strings instead of failing to parse.
      settledAs({
        registrationStatus: 'failed',
        registrationFailureReason: 'a_reason_from_a_later_release',
      });

      await expect(retry()).resolves.toMatchObject({ registrationFailureReason: 'rejected' });
    });

    it('re-throws anything that is not a Meta failure rather than recording it as one', async () => {
      // A bug in this service is a fault. Recording it as a registration Meta
      // refused would hide it behind a reason a tenant is told to act on.
      registerPhoneNumber.mockRejectedValue(new TypeError('undefined is not a function'));

      await expect(retry()).rejects.toBeInstanceOf(TypeError);
      expect(tx.whatsappAccount.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('the access token', () => {
    it('uses the one it was handed on the signup path rather than reading the row', async () => {
      await service.register({
        whatsappAccountId: ACCOUNT_ID,
        accessToken: 'a-token-still-in-hand',
        attempt: 'initial',
      });

      expect(forPhoneNumber).not.toHaveBeenCalled();
      expect(registerPhoneNumber).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: 'a-token-still-in-hand' }),
      );
    });

    it('resolves it before claiming the row, so a bad credential leaves nothing pending', async () => {
      forPhoneNumber.mockRejectedValue(new WhatsAppAccountNotFoundError(ACCOUNT_ID));

      await expect(retry()).rejects.toBeInstanceOf(WhatsAppAccountNotFoundError);
      expect(tx.whatsappAccount.update).not.toHaveBeenCalled();
    });
  });
});
