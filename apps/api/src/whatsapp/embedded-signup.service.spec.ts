import { Logger } from '@nestjs/common';
import type { WhatsAppRegistrationFailureReason } from '@whatsappcrm/contracts';
import type {
  ConnectBusinessAccountResult,
  ConnectedPhoneNumber,
  WhatsAppBusinessAccountConnectionService,
} from './business-account-connection.service';
import type {
  NumberRegistrationState,
  WhatsAppPhoneNumberRegistrationService,
} from './phone-number-registration.service';
import { WhatsAppEmbeddedSignupService } from './embedded-signup.service';
import type { MetaCloudApiClient } from './meta-cloud-api.client';
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

const ACCOUNT_ID = '70444444-4444-7444-8444-444444444401';
const SECOND_ACCOUNT_ID = '70444444-4444-7444-8444-444444444402';
const SECOND_PHONE_NUMBER_ID = '15550002222';

/** One connected number, straight out of `connect()` — never registered yet. */
function connectedNumber(id: string, phoneNumberId: string): ConnectedPhoneNumber {
  return {
    id,
    whatsappBusinessAccountId: '60444444-4444-7444-8444-444444444401',
    phoneNumberId,
    displayPhoneNumber: '+966501234567',
    verifiedName: "Jasper's Market",
    qualityRating: 'green',
    status: 'connected',
    registrationStatus: 'unregistered',
    registrationFailureReason: null,
    registeredAt: null,
    registrationAttemptedAt: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function connectionOf(...numbers: ConnectedPhoneNumber[]): ConnectBusinessAccountResult {
  return {
    created: true,
    businessAccount: {
      id: '60444444-4444-7444-8444-444444444401',
      wabaId: WABA_ID,
      name: "Jasper's Market",
      verificationStatus: 'verified',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      accounts: numbers,
    },
  };
}

const CONNECTED = connectionOf(connectedNumber(ACCOUNT_ID, PHONE_NUMBER_ID));

/** What the registration service answers when Meta accepted the number. */
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
    register = jest
      .fn()
      .mockImplementation(({ whatsappAccountId }: { whatsappAccountId: string }) =>
        Promise.resolve(
          registered(
            whatsappAccountId,
            whatsappAccountId === ACCOUNT_ID ? PHONE_NUMBER_ID : SECOND_PHONE_NUMBER_ID,
          ),
        ),
      );
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
    await expect(run()).resolves.toEqual(
      connectionOf({
        ...connectedNumber(ACCOUNT_ID, PHONE_NUMBER_ID),
        registrationStatus: 'registered',
        registeredAt: TIMESTAMP,
        registrationAttemptedAt: TIMESTAMP,
      }),
    );

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

  describe('registering the connected numbers for sending', () => {
    it('registers every number after the connection commits, never before it', async () => {
      // The one Meta call that has to be on the other side of the transaction:
      // it sends a PIN this platform invented, so the PIN must be durable first.
      await run();

      expect(register).toHaveBeenCalledWith({
        whatsappAccountId: ACCOUNT_ID,
        accessToken: BUSINESS_TOKEN,
        attempt: 'initial',
      });
      expect(connect.mock.invocationCallOrder[0]).toBeLessThan(
        register.mock.invocationCallOrder[0] as number,
      );
    });

    it('publishes the outcome on the connect response, so the console needs no second call', async () => {
      register.mockResolvedValue(
        registrationFailed(ACCOUNT_ID, PHONE_NUMBER_ID, 'credential_rejected'),
      );

      const result = await run();

      expect(result.businessAccount.accounts[0]).toMatchObject({
        status: 'connected',
        registrationStatus: 'failed',
        registrationFailureReason: 'credential_rejected',
      });
    });

    it('keeps the connection when registration fails, because receive is unaffected', async () => {
      register.mockResolvedValue(registrationFailed(ACCOUNT_ID, PHONE_NUMBER_ID, 'rejected'));

      // Not a rejection: discarding a working inbound connection over a
      // send-side failure that is retryable would be the worse trade.
      await expect(run()).resolves.toMatchObject({ created: true });
    });

    it.each([['rate_limited' as const], ['upstream_unavailable' as const]])(
      'stops the loop on %s and leaves the rest unregistered and retryable',
      async (reason) => {
        connect.mockResolvedValue(
          connectionOf(
            connectedNumber(ACCOUNT_ID, PHONE_NUMBER_ID),
            connectedNumber(SECOND_ACCOUNT_ID, SECOND_PHONE_NUMBER_ID),
          ),
        );
        register.mockResolvedValueOnce(registrationFailed(ACCOUNT_ID, PHONE_NUMBER_ID, reason));

        const result = await run();

        // Meta is not answering us; the second call would fail identically and
        // would spend what is left of the request finding that out.
        expect(register).toHaveBeenCalledTimes(1);
        expect(result.businessAccount.accounts[1]).toMatchObject({
          registrationStatus: 'unregistered',
          registrationFailureReason: null,
        });
      },
    );

    it('carries on past a per-number refusal, because Meta answered about that number only', async () => {
      connect.mockResolvedValue(
        connectionOf(
          connectedNumber(ACCOUNT_ID, PHONE_NUMBER_ID),
          connectedNumber(SECOND_ACCOUNT_ID, SECOND_PHONE_NUMBER_ID),
        ),
      );
      register.mockResolvedValueOnce(registrationFailed(ACCOUNT_ID, PHONE_NUMBER_ID, 'rejected'));

      const result = await run();

      expect(register).toHaveBeenCalledTimes(2);
      expect(result.businessAccount.accounts[1]).toMatchObject({
        registrationStatus: 'registered',
      });
    });

    it('answers the connection even when registration could not be attempted at all', async () => {
      // A database failure inside the registration service. The WABA is
      // connected; reporting a 500 would tell the tenant it is not.
      register.mockRejectedValue(new Error('the registration transaction failed'));

      const result = await run();

      expect(result.businessAccount.accounts[0]).toMatchObject({
        registrationStatus: 'unregistered',
      });
      expect(warned().join('\n')).toContain(PHONE_NUMBER_ID);
    });
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
});
