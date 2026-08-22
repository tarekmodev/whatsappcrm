import { Logger } from '@nestjs/common';
import type { WhatsAppRegistrationFailureReason } from '@whatsappcrm/contracts';
import type {
  ConnectBusinessAccountResult,
  WhatsAppBusinessAccountConnectionService,
} from './business-account-connection.service';
import { WhatsAppEmbeddedSignupService } from './embedded-signup.service';
import type { MetaCloudApiClient } from './meta-cloud-api.client';
import type {
  NumberRegistrationState,
  WhatsAppPhoneNumberRegistrationService,
} from './phone-number-registration.service';
import {
  MetaAuthenticationError,
  MetaRateLimitedError,
  MetaRequestRejectedError,
  MetaUnavailableError,
} from './meta-cloud-api.errors';
import { WhatsAppIdentityTakenError, WhatsAppSignupFailedError } from './whatsapp.errors';

/**
 * The orchestration between Meta and the connection service.
 *
 * The assertions worth being loudest about are the ordering ones: every Meta
 * call happens before `connect()`, so no failure among them can leave a WABA row
 * or a stored credential behind. The rest is the failure taxonomy — which Meta
 * refusal becomes which published reason — because that is what tells the
 * console whether re-running the flow can possibly help.
 */

const WABA_ID = '102290129340398';
const PHONE_NUMBER_ID = '15550001111';
const CODE = 'AQD-an-exchangeable-token-code';
const BUSINESS_TOKEN = 'EAAG-a-business-integration-system-user-token';
const TIMESTAMP = new Date('2026-08-11T09:00:00.000Z');

const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';
const ACCOUNT_ROW_ID = '70444444-4444-7444-8444-444444444401';

/** As `connect()` writes a number: attached, receiving, and not yet able to send. */
function connectedNumber(id: string, phoneNumberId: string) {
  return {
    id,
    whatsappBusinessAccountId: WABA_ROW_ID,
    phoneNumberId,
    displayPhoneNumber: '+966501234567',
    verifiedName: "Jasper's Market",
    qualityRating: 'green' as const,
    status: 'connected' as const,
    registrationStatus: 'unregistered' as const,
    registrationFailureReason: null,
    registeredAt: null,
    registrationAttemptedAt: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

const CONNECTED: ConnectBusinessAccountResult = {
  created: true,
  businessAccount: {
    id: WABA_ROW_ID,
    wabaId: WABA_ID,
    name: "Jasper's Market",
    verificationStatus: 'verified',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    accounts: [connectedNumber(ACCOUNT_ROW_ID, PHONE_NUMBER_ID)],
  },
};

/** What `WhatsAppPhoneNumberRegistrationService.register` answers, per outcome. */
function registered(whatsappAccountId: string, phoneNumberId: string): NumberRegistrationState {
  return {
    whatsappAccountId,
    phoneNumberId,
    registrationStatus: 'registered',
    registrationFailureReason: null,
    registeredAt: TIMESTAMP,
    registrationAttemptedAt: TIMESTAMP,
  };
}

function registrationFailed(
  whatsappAccountId: string,
  phoneNumberId: string,
  reason: WhatsAppRegistrationFailureReason,
): NumberRegistrationState {
  return {
    whatsappAccountId,
    phoneNumberId,
    registrationStatus: 'failed',
    registrationFailureReason: reason,
    registeredAt: null,
    registrationAttemptedAt: TIMESTAMP,
  };
}

function metaRejects(subcode: number | null, status = 400): MetaRequestRejectedError {
  return new MetaRequestRejectedError(status, {
    code: 100,
    subcode,
    message: 'Meta said something only an operator can act on',
    traceId: 'Az8...',
  });
}

describe('connecting a WABA through Embedded Signup', () => {
  let exchangeSignupCode: jest.Mock;
  let describeBusinessAccount: jest.Mock;
  let listPhoneNumbers: jest.Mock;
  let subscribeApp: jest.Mock;
  let connect: jest.Mock;
  let register: jest.Mock;
  let service: WhatsAppEmbeddedSignupService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    exchangeSignupCode = jest
      .fn()
      .mockResolvedValue({ accessToken: BUSINESS_TOKEN, expiresInSeconds: null });
    describeBusinessAccount = jest.fn().mockResolvedValue({
      wabaId: WABA_ID,
      name: "Jasper's Market",
      verificationStatus: 'verified',
    });
    listPhoneNumbers = jest.fn().mockResolvedValue({
      phoneNumbers: [
        {
          phoneNumberId: PHONE_NUMBER_ID,
          displayPhoneNumber: '+966 50 123 4567',
          verifiedName: "Jasper's Market",
          qualityRating: 'green',
        },
      ],
      hasMore: false,
    });
    subscribeApp = jest.fn().mockResolvedValue(undefined);
    connect = jest.fn().mockResolvedValue(CONNECTED);
    register = jest.fn().mockResolvedValue(registered(ACCOUNT_ROW_ID, PHONE_NUMBER_ID));
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    service = new WhatsAppEmbeddedSignupService(
      {
        exchangeSignupCode,
        describeBusinessAccount,
        listPhoneNumbers,
        subscribeApp,
      } as unknown as MetaCloudApiClient,
      { connect } as unknown as WhatsAppBusinessAccountConnectionService,
      { register } as unknown as WhatsAppPhoneNumberRegistrationService,
    );
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function run() {
    return service.connect({ code: CODE, wabaId: WABA_ID });
  }

  /** Every line the service warned about, as text. */
  function warned(): string[] {
    return (warn.mock.calls as unknown[][]).map((call) => String(call[0]));
  }

  it('exchanges the code, verifies the WABA, hydrates from Meta and only then connects', async () => {
    await expect(run()).resolves.toMatchObject({
      created: true,
      businessAccount: { id: WABA_ROW_ID, wabaId: WABA_ID },
    });

    expect(exchangeSignupCode).toHaveBeenCalledWith({ code: CODE });
    expect(describeBusinessAccount).toHaveBeenCalledWith({
      wabaId: WABA_ID,
      accessToken: BUSINESS_TOKEN,
    });
    expect(listPhoneNumbers).toHaveBeenCalledWith({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN });
    expect(subscribeApp).toHaveBeenCalledWith({ wabaId: WABA_ID, accessToken: BUSINESS_TOKEN });
  });

  it('subscribes to the WABA’s webhooks before the row is written, not after', async () => {
    // Without the subscription the connection looks healthy and the inbox stays
    // empty; after the row, a failure would leave one that does.
    await run();

    expect(subscribeApp.mock.invocationCallOrder[0]).toBeLessThan(
      connect.mock.invocationCallOrder[0] as number,
    );
  });

  it('builds the connection from Meta’s answers rather than from the request', async () => {
    await run();

    expect(connect).toHaveBeenCalledWith({
      wabaId: WABA_ID,
      name: "Jasper's Market",
      accessToken: BUSINESS_TOKEN,
      verificationStatus: 'verified',
      phoneNumbers: [
        {
          phoneNumberId: PHONE_NUMBER_ID,
          // Meta formats the number for people; the contract publishes E.164.
          displayPhoneNumber: '+966501234567',
          verifiedName: "Jasper's Market",
          qualityRating: 'green',
        },
      ],
    });
  });

  it('omits what Meta has not reported rather than erasing what a previous connection recorded', async () => {
    describeBusinessAccount.mockResolvedValue({
      wabaId: WABA_ID,
      name: null,
      verificationStatus: null,
    });
    listPhoneNumbers.mockResolvedValue({
      phoneNumbers: [
        {
          phoneNumberId: PHONE_NUMBER_ID,
          displayPhoneNumber: '+15550001111',
          verifiedName: null,
          qualityRating: null,
        },
      ],
      hasMore: false,
    });

    await run();

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: undefined,
        verificationStatus: undefined,
        phoneNumbers: [{ phoneNumberId: PHONE_NUMBER_ID, displayPhoneNumber: '+15550001111' }],
      }),
    );
  });

  it.each([
    ['an expired code', 'exchange' as const, metaRejects(36007), 'code_expired'],
    ['a spent code', 'exchange' as const, metaRejects(36009), 'code_invalid'],
    ['a code Meta will not parse', 'exchange' as const, metaRejects(null), 'code_invalid'],
    [
      'a grant missing a permission',
      'exchange' as const,
      new MetaAuthenticationError(400, null),
      'insufficient_permissions',
    ],
    [
      'an environment with no Meta app configured',
      'exchange' as const,
      metaRejects(null, 0),
      'insufficient_permissions',
    ],
    [
      'a token that cannot read the WABA',
      'read-back' as const,
      new MetaAuthenticationError(400, null),
      'waba_mismatch',
    ],
    ['a WABA the grant does not cover', 'read-back' as const, metaRejects(33), 'waba_mismatch'],
    [
      'a grant that cannot list the numbers',
      'numbers' as const,
      new MetaAuthenticationError(403, null),
      'insufficient_permissions',
    ],
    [
      'a grant that cannot subscribe the app',
      'subscribe' as const,
      metaRejects(null),
      'insufficient_permissions',
    ],
  ])('reports %s as %s → %s', async (_case, step, thrown, reason) => {
    const failing = {
      exchange: exchangeSignupCode,
      'read-back': describeBusinessAccount,
      numbers: listPhoneNumbers,
      subscribe: subscribeApp,
    }[step];

    failing.mockRejectedValue(thrown);

    const error = await run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WhatsAppSignupFailedError);
    expect((error as WhatsAppSignupFailedError).reason).toBe(reason);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a WABA Meta answers about under a different id', async () => {
    describeBusinessAccount.mockResolvedValue({
      wabaId: '999999999999999',
      name: null,
      verificationStatus: null,
    });

    const error = await run().catch((caught: unknown) => caught);

    expect((error as WhatsAppSignupFailedError).reason).toBe('waba_mismatch');
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a WABA with no phone number, because it can neither send nor receive', async () => {
    listPhoneNumbers.mockResolvedValue({ phoneNumbers: [], hasMore: false });

    const error = await run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WhatsAppSignupFailedError);
    // Not one of the four published reasons, and the contract already says a
    // client must fall back on a reason it does not recognise.
    expect((error as WhatsAppSignupFailedError).reason).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a number it cannot store as E.164 rather than writing a row that breaks the contract', async () => {
    listPhoneNumbers.mockResolvedValue({
      phoneNumbers: [
        {
          phoneNumberId: PHONE_NUMBER_ID,
          displayPhoneNumber: 'not a phone number',
          verifiedName: null,
          qualityRating: null,
        },
      ],
      hasMore: false,
    });

    await expect(run()).rejects.toBeInstanceOf(WhatsAppSignupFailedError);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ['throttling', new MetaRateLimitedError(429, null, 30), MetaRateLimitedError],
    ['an outage', new MetaUnavailableError(503, null, 'HTTP 503'), MetaUnavailableError],
  ])(
    'leaves Meta %s untranslated, because those already say "later"',
    async (_case, thrown, type) => {
      exchangeSignupCode.mockRejectedValue(thrown);

      await expect(run()).rejects.toBeInstanceOf(type);
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it('lets a collision with another tenant’s WABA through as it is', async () => {
    // The connection service owns that decision; translating it here would put
    // two answers to the same condition in the codebase.
    connect.mockRejectedValue(new WhatsAppIdentityTakenError('waba', WABA_ID));

    await expect(run()).rejects.toBeInstanceOf(WhatsAppIdentityTakenError);
  });

  it('never puts the code or the token in a log line or in an error', async () => {
    exchangeSignupCode.mockRejectedValue(metaRejects(36007));

    const error = await run().catch((caught: unknown) => caught);

    for (const line of warned()) {
      expect(line).not.toContain(CODE);
      expect(line).not.toContain(BUSINESS_TOKEN);
    }

    expect((error as Error).message).not.toContain(CODE);
  });

  it('flags a token Meta says will expire, because the schema stores no expiry', async () => {
    exchangeSignupCode.mockResolvedValue({
      accessToken: BUSINESS_TOKEN,
      expiresInSeconds: 5_183_814,
    });

    await run();

    expect(warned().join('\n')).toContain('expires in');
  });

  it('reports a WABA larger than one page rather than truncating it silently', async () => {
    listPhoneNumbers.mockResolvedValue({
      phoneNumbers: [
        {
          phoneNumberId: PHONE_NUMBER_ID,
          displayPhoneNumber: '+15550001111',
          verifiedName: null,
          qualityRating: null,
        },
      ],
      hasMore: true,
    });

    await run();

    expect(warned().join('\n')).toContain('more phone numbers than one page');
  });

  /**
   * Registering the number for sending (TAR-170). The assertions that carry
   * weight are the ordering one — it runs *after* the row exists, so the PIN is
   * durable before Meta ever sees it — and that no outcome of it can cost the
   * tenant the inbound connection.
   */
  describe('registering the connected numbers for sending', () => {
    const SECOND_ACCOUNT_ROW_ID = '70444444-4444-7444-8444-444444444402';
    const SECOND_PHONE_NUMBER_ID = '15550002222';

    function connectTwoNumbers(): void {
      connect.mockResolvedValue({
        ...CONNECTED,
        businessAccount: {
          ...CONNECTED.businessAccount,
          accounts: [
            connectedNumber(ACCOUNT_ROW_ID, PHONE_NUMBER_ID),
            connectedNumber(SECOND_ACCOUNT_ROW_ID, SECOND_PHONE_NUMBER_ID),
          ],
        },
      });
    }

    it('registers each connected number with the token the exchange just produced', async () => {
      await run();

      expect(register).toHaveBeenCalledWith({
        whatsappAccountId: ACCOUNT_ROW_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        wabaId: WABA_ID,
        accessToken: BUSINESS_TOKEN,
      });
    });

    it('registers only after the row exists, so the PIN is durable before Meta sees it', async () => {
      // The ordering constraint the whole design rests on: a register that
      // succeeded against a transaction that then rolled back would leave Meta
      // holding a PIN this platform cannot reproduce.
      await run();

      expect(connect.mock.invocationCallOrder[0]).toBeLessThan(
        register.mock.invocationCallOrder[0] as number,
      );
    });

    it('reports a registered number as able to send', async () => {
      const result = await run();

      expect(result.businessAccount.accounts[0]).toMatchObject({
        status: 'connected',
        registrationStatus: 'registered',
        registrationFailureReason: null,
        registeredAt: TIMESTAMP,
      });
    });

    it('keeps the connection and reports the reason when registration fails', async () => {
      // "Connected — sending unavailable", not a rolled-back connection: the
      // number still receives, and the row the retry hangs off still exists.
      register.mockResolvedValue(
        registrationFailed(ACCOUNT_ROW_ID, PHONE_NUMBER_ID, 'credential_rejected'),
      );

      const result = await run();

      expect(result.businessAccount.accounts[0]).toMatchObject({
        status: 'connected',
        registrationStatus: 'failed',
        registrationFailureReason: 'credential_rejected',
      });
    });

    it('carries on to the next number when Meta refuses one of them', async () => {
      // A rejection is about *that* number: Meta answered, and quickly.
      connectTwoNumbers();
      register
        .mockResolvedValueOnce(registrationFailed(ACCOUNT_ROW_ID, PHONE_NUMBER_ID, 'rejected'))
        .mockResolvedValueOnce(registered(SECOND_ACCOUNT_ROW_ID, SECOND_PHONE_NUMBER_ID));

      const result = await run();

      expect(register).toHaveBeenCalledTimes(2);
      expect(result.businessAccount.accounts.map((account) => account.registrationStatus)).toEqual([
        'failed',
        'registered',
      ]);
    });

    it.each(['rate_limited' as const, 'upstream_unavailable' as const])(
      'stops at the first %s and leaves the rest honestly unregistered',
      async (reason) => {
        // Both mean Meta is not answering us right now, so every call after this
        // one would fail identically and spend the request's remaining time.
        connectTwoNumbers();
        register.mockResolvedValueOnce(registrationFailed(ACCOUNT_ROW_ID, PHONE_NUMBER_ID, reason));

        const result = await run();

        expect(register).toHaveBeenCalledTimes(1);
        expect(
          result.businessAccount.accounts.map((account) => account.registrationStatus),
        ).toEqual(['failed', 'unregistered']);
        expect(warned().join('\n')).toContain('were not attempted');
      },
    );

    it('keeps the connection when registration faults, rather than failing a spent code', async () => {
      // By this point the connection has committed and Meta's code is spent, so
      // a 500 would report a connection that exists as one that failed and send
      // the tenant back through a flow that cannot succeed.
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      register.mockRejectedValue(new Error('the database is unreachable'));

      const result = await run();

      expect(result.businessAccount.accounts[0]).toMatchObject({
        status: 'connected',
        registrationStatus: 'unregistered',
      });
      expect(error).toHaveBeenCalled();

      error.mockRestore();
    });

    it('registers the next number even when one of them faults', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      connectTwoNumbers();
      register
        .mockRejectedValueOnce(new Error('the database is unreachable'))
        .mockResolvedValueOnce(registered(SECOND_ACCOUNT_ROW_ID, SECOND_PHONE_NUMBER_ID));

      const result = await run();

      expect(result.businessAccount.accounts.map((account) => account.registrationStatus)).toEqual([
        'unregistered',
        'registered',
      ]);

      error.mockRestore();
    });
  });
});
