import { describe, expect, it } from 'vitest';
import type {
  ConnectedWhatsAppBusinessAccountResponse,
  WhatsAppAccountResponse,
} from '@whatsappcrm/contracts';
import {
  autoSelectedWhatsAppNumberId,
  EMPTY_WHATSAPP_WIZARD_PROGRESS,
  isWhatsAppWizardComplete,
  selectedWhatsAppNumber,
  whatsAppNumberProblem,
  whatsAppWizardResolvedCount,
  whatsAppWizardStatuses,
  withWhatsAppRegistration,
  type WhatsAppWizardProgress,
} from './wizard';

/**
 * The wizard's step machine, on its own.
 *
 * It is a pure module for the reason `conversation-chips.ts` and
 * `ticket-chips.ts` are: which step is which colour is a decision with a
 * dependency chain in it, and a decision that lives inside a component can only
 * be tested by rendering one. These are the cases that would otherwise need four
 * clicks and a mocked SDK each.
 */

const ACCOUNT_ID = '0192f100-0000-7000-8000-000000000001';
const NUMBER_ID = '0192f100-0000-7000-8000-000000000002';
const OTHER_NUMBER_ID = '0192f100-0000-7000-8000-000000000003';
const AT = '2026-08-11T10:00:00.000Z';

function number(overrides: Partial<WhatsAppAccountResponse> = {}): WhatsAppAccountResponse {
  return {
    id: NUMBER_ID,
    whatsappBusinessAccountId: ACCOUNT_ID,
    phoneNumberId: '106540352242922',
    displayPhoneNumber: '+966501234567',
    verifiedName: 'Northwind Support',
    qualityRating: null,
    status: 'connected',
    registrationStatus: 'unregistered',
    registrationFailureReason: null,
    registeredAt: null,
    registrationAttemptedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function account(
  numbers: readonly WhatsAppAccountResponse[] = [number()],
): ConnectedWhatsAppBusinessAccountResponse {
  return {
    id: ACCOUNT_ID,
    wabaId: '102290129340398',
    name: 'Northwind Traders',
    verificationStatus: 'verified',
    createdAt: AT,
    updatedAt: AT,
    accounts: [...numbers],
  };
}

function progress(overrides: Partial<WhatsAppWizardProgress> = {}): WhatsAppWizardProgress {
  return {
    account: account(),
    selectedNumberId: NUMBER_ID,
    hasInbound: false,
    ...overrides,
  };
}

describe('whatsAppWizardStatuses', () => {
  it('opens on the first step and leaves the rest out of reach', () => {
    const statuses = whatsAppWizardStatuses(EMPTY_WHATSAPP_WIZARD_PROGRESS, null);

    expect(statuses).toEqual({
      connect_account: 'current',
      select_number: 'upcoming',
      register_number: 'upcoming',
      test_send: 'upcoming',
    });
  });

  /**
   * The property the dependency chain exists to hold: a step nobody can attempt
   * is never drawn as one that needs attention. A red marker beside work that
   * has not started sends somebody looking for a problem that is not theirs yet.
   */
  it('keeps later steps upcoming when the connection failed', () => {
    const statuses = whatsAppWizardStatuses(EMPTY_WHATSAPP_WIZARD_PROGRESS, {
      step: 'connect_account',
      report: { failure: 'rate_limited', detail: null, requestId: null },
    });

    expect(statuses.connect_account).toBe('error');
    expect(statuses.select_number).toBe('upcoming');
    expect(statuses.register_number).toBe('upcoming');
    expect(statuses.test_send).toBe('upcoming');
  });

  it('asks for a number when the account holds more than one', () => {
    const statuses = whatsAppWizardStatuses(
      progress({
        account: account([number(), number({ id: OTHER_NUMBER_ID })]),
        selectedNumberId: null,
      }),
      null,
    );

    expect(statuses.connect_account).toBe('done');
    expect(statuses.select_number).toBe('current');
    expect(statuses.register_number).toBe('upcoming');
  });

  it('needs attention when the connected account has no numbers at all', () => {
    const statuses = whatsAppWizardStatuses(
      progress({ account: account([]), selectedNumberId: null }),
      null,
    );

    expect(statuses.select_number).toBe('error');
  });

  /**
   * The silent-inbox failure, as a status. A number Meta never registered is
   * `connected` and unable to send, and the whole point of the second axis is
   * that this does not read as done.
   */
  it('holds the flow at registration for a number that cannot send', () => {
    const statuses = whatsAppWizardStatuses(progress(), null);

    expect(statuses.select_number).toBe('done');
    expect(statuses.register_number).toBe('current');
    expect(statuses.test_send).toBe('upcoming');
  });

  it.each(['pending', 'unregistered'] as const)(
    'treats %s as work still to do rather than as a refusal',
    (registrationStatus) => {
      const statuses = whatsAppWizardStatuses(
        progress({ account: account([number({ registrationStatus })]) }),
        null,
      );

      expect(statuses.register_number).toBe('current');
    },
  );

  it('reports a refused registration as a step that needs attention', () => {
    const statuses = whatsAppWizardStatuses(
      progress({
        account: account([
          number({ registrationStatus: 'failed', registrationFailureReason: 'pin_rejected' }),
        ]),
      }),
      null,
    );

    expect(statuses.register_number).toBe('error');
  });

  it('reaches the last step only once the number can send', () => {
    const statuses = whatsAppWizardStatuses(
      progress({ account: account([number({ registrationStatus: 'registered' })]) }),
      null,
    );

    expect(statuses.register_number).toBe('done');
    expect(statuses.test_send).toBe('current');
  });

  it('finishes when a message has been seen on the number', () => {
    const statuses = whatsAppWizardStatuses(
      progress({
        account: account([number({ registrationStatus: 'registered' })]),
        hasInbound: true,
      }),
      null,
    );

    expect(isWhatsAppWizardComplete(statuses)).toBe(true);
    expect(whatsAppWizardResolvedCount(statuses)).toBe(4);
  });
});

describe('whatsAppNumberProblem', () => {
  it('reports nothing before a connection exists', () => {
    expect(whatsAppNumberProblem(EMPTY_WHATSAPP_WIZARD_PROGRESS)).toBeNull();
  });

  it('reports an account Meta attached no numbers to', () => {
    expect(whatsAppNumberProblem(progress({ account: account([]), selectedNumberId: null }))).toBe(
      'no_numbers',
    );
  });

  it('reports a chosen number Meta calls broken', () => {
    expect(
      whatsAppNumberProblem(progress({ account: account([number({ status: 'error' })]) })),
    ).toBe('number_unusable');
  });

  /**
   * Meta reports `disconnected` for a number that is attached and currently
   * unreachable. That is a thing to say on the row, not a reason to refuse the
   * selection — the number is still the one this workspace holds.
   */
  it('does not treat a disconnected number as a problem to block on', () => {
    expect(
      whatsAppNumberProblem(progress({ account: account([number({ status: 'disconnected' })]) })),
    ).toBeNull();
  });
});

describe('autoSelectedWhatsAppNumberId', () => {
  it('chooses the only number there is', () => {
    expect(autoSelectedWhatsAppNumberId(account())).toBe(NUMBER_ID);
  });

  it.each([
    ['none', account([])],
    ['several', account([number(), number({ id: OTHER_NUMBER_ID })])],
  ])('leaves the choice open when the account holds %s', (_label, held) => {
    expect(autoSelectedWhatsAppNumberId(held)).toBeNull();
  });
});

describe('withWhatsAppRegistration', () => {
  it('folds a registration answer onto the number it names, and no other', () => {
    const updated = withWhatsAppRegistration(
      progress({ account: account([number(), number({ id: OTHER_NUMBER_ID })]) }),
      {
        id: NUMBER_ID,
        registrationStatus: 'registered',
        registrationFailureReason: null,
        registeredAt: AT,
        registrationAttemptedAt: AT,
      },
    );

    expect(selectedWhatsAppNumber(updated)?.registrationStatus).toBe('registered');
    expect(updated.account?.accounts[1]?.registrationStatus).toBe('unregistered');
  });

  /** A response for a number the wizard is not holding is not something to merge on a guess. */
  it('leaves progress alone for an id it does not hold', () => {
    const before = progress();
    const after = withWhatsAppRegistration(before, {
      id: OTHER_NUMBER_ID,
      registrationStatus: 'registered',
      registrationFailureReason: null,
      registeredAt: AT,
      registrationAttemptedAt: AT,
    });

    expect(after.account?.accounts).toEqual(before.account?.accounts);
  });
});
