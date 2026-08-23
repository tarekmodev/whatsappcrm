import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedWhatsAppBusinessAccountResponse } from '@whatsappcrm/contracts';
import { EMPTY_WHATSAPP_WIZARD_PROGRESS, type WhatsAppWizardProgress } from './wizard';
import {
  clearWhatsAppWizardProgress,
  readWhatsAppWizardProgress,
  writeWhatsAppWizardProgress,
} from './wizard-storage';

/**
 * The wizard's resume, which is the one thing here with no server read behind
 * it: the API publishes no tenant-facing `GET` for a connected WABA, so a reload
 * restores from this or restores nothing.
 *
 * That makes the *rejection* cases the ones worth pinning down. A value read
 * back has been outside the type system — a stale build wrote it, a devtools
 * console edited it, a later contract renamed a field — and anything this cannot
 * parse has to start the flow from the top rather than render half a connection.
 */

const STORAGE_KEY = 'whatsappcrm.whatsapp-wizard';
const ACCOUNT_ID = '0192f100-0000-7000-8000-000000000001';
const NUMBER_ID = '0192f100-0000-7000-8000-000000000002';
const AT = '2026-08-11T10:00:00.000Z';

const ACCOUNT: ConnectedWhatsAppBusinessAccountResponse = {
  id: ACCOUNT_ID,
  wabaId: '102290129340398',
  name: 'Northwind Traders',
  verificationStatus: 'verified',
  createdAt: AT,
  updatedAt: AT,
  accounts: [
    {
      id: NUMBER_ID,
      whatsappBusinessAccountId: ACCOUNT_ID,
      phoneNumberId: '106540352242922',
      displayPhoneNumber: '+966501234567',
      verifiedName: 'Northwind Support',
      qualityRating: null,
      status: 'connected',
      registrationStatus: 'registered',
      registrationFailureReason: null,
      registeredAt: AT,
      registrationAttemptedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    },
  ],
};

const PROGRESS: WhatsAppWizardProgress = {
  account: ACCOUNT,
  selectedNumberId: NUMBER_ID,
  hasInbound: true,
};

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('the wizard’s stored progress', () => {
  it('round-trips a connection it wrote itself', () => {
    writeWhatsAppWizardProgress(PROGRESS);

    expect(readWhatsAppWizardProgress()).toEqual(PROGRESS);
  });

  it('reads nothing back when nothing was written', () => {
    expect(readWhatsAppWizardProgress()).toEqual(EMPTY_WHATSAPP_WIZARD_PROGRESS);
  });

  /**
   * The contract asserts that no response schema carries the WABA access token
   * or the registration PIN, which is what makes writing a connect response to
   * browser storage acceptable at all. Asserted here as well, because this is
   * the one place in the console where such a body is written down.
   */
  it('writes no credential, because the body it stores carries none', () => {
    writeWhatsAppWizardProgress(PROGRESS);

    const raw = window.sessionStorage.getItem(STORAGE_KEY) ?? '';

    expect(raw).not.toContain('accessToken');
    expect(raw).not.toContain('pin');
  });

  it('forgets everything rather than storing a flow that has not started', () => {
    writeWhatsAppWizardProgress(PROGRESS);
    writeWhatsAppWizardProgress(EMPTY_WHATSAPP_WIZARD_PROGRESS);

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('forgets everything when asked', () => {
    writeWhatsAppWizardProgress(PROGRESS);
    clearWhatsAppWizardProgress();

    expect(readWhatsAppWizardProgress()).toEqual(EMPTY_WHATSAPP_WIZARD_PROGRESS);
  });
});

describe('the wizard’s stored progress: what it refuses', () => {
  it.each([
    ['not JSON at all', 'nonsense{'],
    ['a payload from a build that shaped this differently', JSON.stringify({ version: 99 })],
    ['a bare value where an object belongs', JSON.stringify(42)],
    [
      'an account the contract rejects',
      JSON.stringify({ version: 1, account: { wabaId: 42 }, selectedNumberId: NUMBER_ID }),
    ],
  ])('starts from the top for %s', (_label, raw) => {
    window.sessionStorage.setItem(STORAGE_KEY, raw);

    expect(readWhatsAppWizardProgress()).toEqual(EMPTY_WHATSAPP_WIZARD_PROGRESS);
  });

  it('drops a payload it could not parse rather than leaving it to fail again', () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'nonsense{');
    readWhatsAppWizardProgress();

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  /** A selection pointing at nothing would leave the wizard registering a number it does not hold. */
  it('discards a selection that names no number on the stored account', () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        account: ACCOUNT,
        selectedNumberId: '0192f100-0000-7000-8000-0000000000ff',
        hasInbound: true,
      }),
    );

    expect(readWhatsAppWizardProgress()).toEqual({
      account: ACCOUNT,
      selectedNumberId: null,
      // A remembered inbound is only meaningful about a remembered number.
      hasInbound: false,
    });
  });

  /**
   * Storage denied by a privacy setting, or a full quota. The wizard works for
   * this sitting and will not resume — a degradation, not a failure, and not
   * worth interrupting anybody over.
   */
  it('carries on when the browser refuses to store anything', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    expect(() => {
      writeWhatsAppWizardProgress(PROGRESS);
    }).not.toThrow();

    setItem.mockRestore();
  });
});
