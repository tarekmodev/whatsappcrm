import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { MetaCloudApiClient } from './meta-cloud-api.client';
import {
  MetaAuthenticationError,
  MetaRateLimitedError,
  MetaRequestRejectedError,
  MetaUnavailableError,
} from './meta-cloud-api.errors';
import { WhatsAppPhoneNumberRegistrationService } from './phone-number-registration.service';
import { WhatsAppCredentialCipher } from './whatsapp-credential.cipher';
import { WhatsAppTokenUndecryptableError } from './whatsapp.errors';

/**
 * What the service composes, with no database and no Meta in the way.
 *
 * The assertions that carry weight are the ordering ones — the PIN is committed
 * before Meta is called, and no transaction is open across the call — and the
 * two secrecy ones: the PIN never reaches a log line, a response or an audit
 * row. The rest is the failure taxonomy, because that is what tells a tenant
 * whether retrying can possibly help.
 */

const TENANT_ID = '50444444-4444-7444-8444-444444444401';
const ACCOUNT_ROW_ID = '70444444-4444-7444-8444-444444444401';
const PHONE_NUMBER_ID = '15550001111';
const WABA_ID = '102290129340398';
const ACCESS_TOKEN = 'EAAG-a-business-integration-system-user-token';
const TIMESTAMP = new Date('2026-08-23T09:00:00.000Z');
const TIMEOUT_MS = 10_000;

/** 32 bytes, base64. A test fixture, and obviously not a key from a CSPRNG. */
const KEY = Buffer.alloc(32, 7).toString('base64');

const COMMAND = {
  whatsappAccountId: ACCOUNT_ROW_ID,
  phoneNumberId: PHONE_NUMBER_ID,
  wabaId: WABA_ID,
  accessToken: ACCESS_TOKEN,
};

interface AccountRow {
  id: string;
  phoneNumberId: string;
  registrationStatus: 'unregistered' | 'pending' | 'registered' | 'failed';
  registrationPinEncrypted: string | null;
  registrationFailureReason: string | null;
  registeredAt: Date | null;
  registrationAttemptedAt: Date | null;
}

function row(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: ACCOUNT_ROW_ID,
    phoneNumberId: PHONE_NUMBER_ID,
    registrationStatus: 'unregistered',
    registrationPinEncrypted: null,
    registrationFailureReason: null,
    registeredAt: null,
    registrationAttemptedAt: null,
    ...overrides,
  };
}

function metaRejects(): MetaRequestRejectedError {
  return new MetaRequestRejectedError(400, {
    code: 133_005,
    subcode: null,
    message: 'Meta said something that describes our app rather than this tenant',
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
  auditLog: { create: jest.Mock };
}

/** Only the fields these assertions read. */
interface WriteArgs {
  where?: Record<string, unknown>;
  data: Record<string, unknown>;
}

describe('WhatsAppPhoneNumberRegistrationService', () => {
  let tx: TransactionSpies;
  let registerPhoneNumber: jest.Mock;
  let cipher: WhatsAppCredentialCipher;
  let service: WhatsAppPhoneNumberRegistrationService;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  /** What the row reads at the start of each transaction. */
  let stored: AccountRow;

  beforeEach(() => {
    stored = row();

    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      whatsappAccount: {
        findUnique: jest.fn(() => Promise.resolve(stored)),
        findUniqueOrThrow: jest.fn(() => Promise.resolve(stored)),
        update: jest.fn().mockResolvedValue({ id: ACCOUNT_ROW_ID }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit' }) },
    };

    const prisma = {
      $tenantTransaction: jest.fn(async (work: (client: TransactionSpies) => Promise<unknown>) =>
        work(tx),
      ),
    } as unknown as TenantPrisma;

    registerPhoneNumber = jest.fn().mockResolvedValue(undefined);

    // The real cipher: whether the PIN round-trips through the same path the
    // access token uses is the property under test, not something to stub out.
    cipher = new WhatsAppCredentialCipher({
      get: (name: string) => (name === 'WHATSAPP_TOKEN_ENCRYPTION_KEY' ? KEY : undefined),
    } as unknown as ConfigService);

    const tenantContext = {
      requireTenantId: () => TENANT_ID,
      userId: '80444444-4444-7444-8444-444444444401',
      platformActorLabel: null,
    } as unknown as TenantContextService;

    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    service = new WhatsAppPhoneNumberRegistrationService(
      prisma,
      cipher,
      { registerPhoneNumber } as unknown as MetaCloudApiClient,
      // The real one: the shape of the audit row is what several of these
      // assertions are about.
      new AuditService(tenantContext),
      { getOrThrow: () => TIMEOUT_MS } as unknown as ConfigService,
    );
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  function callArgs(spy: jest.Mock, index = 0): WriteArgs {
    const call = (spy.mock.calls as [WriteArgs][])[index];

    if (call === undefined) {
      throw new Error(`the spy was not called ${index + 1} time(s)`);
    }

    return call[0];
  }

  /** The PIN as the claim transaction wrote it, decrypted back out. */
  function writtenPin(): string {
    const payload = callArgs(tx.whatsappAccount.update).data.registrationPinEncrypted;

    return cipher.decrypt(String(payload), PHONE_NUMBER_ID);
  }

  /** Every line the service logged, at any level, as text. */
  function logged(): string {
    const calls = [...(warn.mock.calls as unknown[][]), ...(log.mock.calls as unknown[][])];

    return calls.map((call) => String(call[0])).join('\n');
  }

  describe('the PIN', () => {
    it('generates six digits and stores them encrypted before Meta is called', async () => {
      await service.register(COMMAND);

      expect(writtenPin()).toMatch(/^\d{6}$/);
      expect(tx.whatsappAccount.update.mock.invocationCallOrder[0]).toBeLessThan(
        registerPhoneNumber.mock.invocationCallOrder[0] as number,
      );
    });

    it('sends Meta the same PIN it stored', async () => {
      await service.register(COMMAND);

      expect(registerPhoneNumber).toHaveBeenCalledWith({
        phoneNumberId: PHONE_NUMBER_ID,
        accessToken: ACCESS_TOKEN,
        pin: writtenPin(),
      });
    });

    it('binds the ciphertext to the phone number, not to the WABA', async () => {
      // Two numbers under one WABA are registered independently and hold
      // different PINs, so a ciphertext copied between their rows must fail.
      await service.register(COMMAND);

      const payload = String(callArgs(tx.whatsappAccount.update).data.registrationPinEncrypted);

      expect(() => cipher.decrypt(payload, WABA_ID)).toThrow(WhatsAppTokenUndecryptableError);
    });

    it('reuses a stored PIN rather than generating a second one', async () => {
      // Why reuse matters: a registration that succeeded but whose outcome was
      // lost is re-attempted, and a *new* PIN would be refused by Meta.
      stored = row({ registrationPinEncrypted: cipher.encrypt('000042', PHONE_NUMBER_ID) });

      await service.register(COMMAND);

      expect(registerPhoneNumber).toHaveBeenCalledWith(expect.objectContaining({ pin: '000042' }));
    });

    it('generates a fresh PIN when the stored one will not decrypt, rather than failing', async () => {
      // A rotated key or a truncated column. The token's own error message tells
      // an operator to re-connect the WABA, which has nothing to do with this.
      stored = row({ registrationPinEncrypted: 'v1.not.a.payload' });

      await service.register(COMMAND);

      expect(writtenPin()).toMatch(/^\d{6}$/);
      expect(logged()).toContain('could not be decrypted');
    });

    it('never puts the PIN in a log line, a response or an audit row', async () => {
      stored = row({ registrationPinEncrypted: cipher.encrypt('314159', PHONE_NUMBER_ID) });

      const state = await service.register(COMMAND);

      expect(logged()).not.toContain('314159');
      expect(JSON.stringify(state)).not.toContain('314159');
      expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain('314159');
    });
  });

  describe('when Meta accepts the number', () => {
    it('marks it registered and stamps when', async () => {
      await service.register(COMMAND);

      const written = callArgs(tx.whatsappAccount.updateMany);

      expect(written.data).toMatchObject({
        registrationStatus: 'registered',
        registrationFailureReason: null,
      });
      expect(written.data.registeredAt).toBeInstanceOf(Date);
    });

    it('audits the success against our id for the number', async () => {
      await service.register(COMMAND);

      expect(callArgs(tx.auditLog.create).data).toMatchObject({
        tenantId: TENANT_ID,
        action: AUDIT_ACTIONS.whatsappPhoneNumberRegistered,
        targetType: 'whatsapp_account',
        targetId: ACCOUNT_ROW_ID,
        metadata: { phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, attempt: 'initial' },
      });
    });
  });

  describe('when Meta refuses', () => {
    it.each([
      ['a rejected credential', new MetaAuthenticationError(401, null), 'credential_rejected'],
      ['throttling', new MetaRateLimitedError(429, null, null), 'rate_limited'],
      ['an outage', new MetaUnavailableError(503, null, 'HTTP 503'), 'upstream_unavailable'],
      // Meta's numeric codes for "already registered" and "PIN mismatch" are not
      // confirmed, and guessing would send somebody to reset a PIN that was
      // never the problem. `rejected` sends them to the audit row instead.
      ['a refusal this build does not model', metaRejects(), 'rejected'],
    ])('records %s as %s', async (_case, thrown, reason) => {
      registerPhoneNumber.mockRejectedValue(thrown);
      stored = row({ registrationStatus: 'failed', registrationFailureReason: reason });

      const state = await service.register(COMMAND);

      expect(callArgs(tx.whatsappAccount.updateMany).data).toMatchObject({
        registrationStatus: 'failed',
        registrationFailureReason: reason,
      });
      expect(state.registrationFailureReason).toBe(reason);
    });

    it('audits the failure with Meta’s own code and trace id, and not its message', async () => {
      // The code and the trace id are the handle a support ticket with Meta is
      // opened on. Meta's free text describes *our* app's grant, and this table
      // is exported for compliance review.
      const rejection = metaRejects();
      registerPhoneNumber.mockRejectedValue(rejection);

      await service.register(COMMAND);

      const audited = callArgs(tx.auditLog.create).data;

      expect(audited).toMatchObject({
        action: AUDIT_ACTIONS.whatsappPhoneNumberRegistrationFailed,
        targetType: 'whatsapp_account',
        metadata: {
          phoneNumberId: PHONE_NUMBER_ID,
          wabaId: WABA_ID,
          attempt: 'initial',
          reason: 'rejected',
          metaCode: 133_005,
          metaTraceId: 'Az8-a-trace-id',
        },
      });
      expect(JSON.stringify(audited)).not.toContain(rejection.detail?.message);
    });

    it('leaves a fault to the caller rather than recording it as a Meta answer', async () => {
      // A bug or a database failure is not something Meta said, and writing
      // `failed` for it would claim a rejection that never happened.
      registerPhoneNumber.mockRejectedValue(new Error('socket closed by the runtime'));

      await expect(service.register(COMMAND)).rejects.toThrow('socket closed');
      expect(tx.whatsappAccount.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('concurrency', () => {
    it('is a no-op for a number that already reads registered', async () => {
      stored = row({ registrationStatus: 'registered', registeredAt: TIMESTAMP });

      const state = await service.register(COMMAND);

      expect(registerPhoneNumber).not.toHaveBeenCalled();
      expect(tx.whatsappAccount.update).not.toHaveBeenCalled();
      expect(state).toMatchObject({ registrationStatus: 'registered', registeredAt: TIMESTAMP });
    });

    it('stands aside for an attempt that is genuinely in flight', async () => {
      stored = row({ registrationStatus: 'pending', registrationAttemptedAt: new Date() });

      await service.register(COMMAND);

      expect(registerPhoneNumber).not.toHaveBeenCalled();
    });

    it('takes over an attempt that died without an answer', async () => {
      // The lease is `META_GRAPH_API_TIMEOUT_MS`: no attempt can outlive its own
      // timeout by much, so an older `pending` row is one nobody is holding.
      stored = row({
        registrationStatus: 'pending',
        registrationAttemptedAt: new Date(Date.now() - TIMEOUT_MS - 1),
      });

      await service.register(COMMAND);

      expect(registerPhoneNumber).toHaveBeenCalled();
    });

    it('claims the row under an advisory lock of its own, not the connection’s', async () => {
      await service.register(COMMAND);

      // A tagged template, so the interpolated lock name arrives as an argument
      // rather than inside the SQL — which is also why it is not injectable.
      expect(tx.$executeRaw).toHaveBeenCalledWith(
        expect.anything(),
        `whatsapp-registration:${PHONE_NUMBER_ID}`,
      );
    });

    it('writes the outcome only while it still owns the row', async () => {
      await service.register(COMMAND);

      expect(callArgs(tx.whatsappAccount.updateMany).where).toEqual({
        id: ACCOUNT_ROW_ID,
        registrationStatus: 'pending',
      });
    });

    it('never downgrades a row a concurrent attempt has already registered', async () => {
      // The compare-and-set matched nothing: another attempt owns the outcome.
      // This one is audited and reports what the row actually says.
      registerPhoneNumber.mockRejectedValue(new MetaUnavailableError(503, null, 'HTTP 503'));
      tx.whatsappAccount.updateMany.mockResolvedValue({ count: 0 });
      tx.whatsappAccount.findUniqueOrThrow.mockImplementation(() =>
        Promise.resolve(row({ registrationStatus: 'registered', registeredAt: TIMESTAMP })),
      );

      const state = await service.register(COMMAND);

      expect(state.registrationStatus).toBe('registered');
      expect(tx.auditLog.create).toHaveBeenCalled();
    });
  });

  it('reads a failure reason this build does not recognise as an unmodelled refusal', async () => {
    // What makes a rollback across an addition to the vocabulary safe: the row
    // renders rather than failing the response schema on every read.
    stored = row({
      registrationStatus: 'registered',
      registrationFailureReason: 'from_the_future',
    });

    const state = await service.register(COMMAND);

    expect(state.registrationFailureReason).toBe('rejected');
  });
});
