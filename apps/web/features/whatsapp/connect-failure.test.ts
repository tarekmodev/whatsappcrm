import { describe, expect, it } from 'vitest';
import {
  WHATSAPP_SIGNUP_FAILURE_REASONS,
  whatsAppSignupFailureDetails,
  type ApiError,
  type WhatsAppSignupFailureReason,
} from '@whatsappcrm/contracts';
import { ApiRequestError } from '@/lib/api/error';
import {
  WHATSAPP_CONNECT_FAILURES,
  connectFailureCopy,
  connectFailureFromError,
  isConnectFailureRetryable,
} from './connect-failure';

/**
 * The taxonomy amendment 2 publishes, at the console's end of it: each reason has
 * to reach a distinct, actionable message, and a code the API adds later has to
 * degrade rather than crash.
 */

const REQUEST_ID = 'req-1';

function apiError(status: number, code: string, details?: ApiError['error']['details']) {
  const envelope: ApiError = {
    error: {
      code,
      message: 'Server-side message',
      requestId: REQUEST_ID,
      ...(details && { details }),
    },
  };

  return new ApiRequestError(status, code, 'Server-side message', REQUEST_ID, envelope);
}

function signupFailure(reason: WhatsAppSignupFailureReason) {
  return apiError(400, 'whatsapp_signup_failed', whatsAppSignupFailureDetails(reason));
}

describe('connectFailureFromError', () => {
  it.each(WHATSAPP_SIGNUP_FAILURE_REASONS)(
    'carries %s through as its own failure, with no server message to show',
    (reason) => {
      expect(connectFailureFromError(signupFailure(reason))).toEqual({
        failure: reason,
        detail: null,
        requestId: REQUEST_ID,
      });
    },
  );

  /**
   * The API publishes `whatsapp_signup_failed` with no reason for cases it has
   * authored a tenant-facing message for — "add a phone number to it in Meta
   * Business Manager", for instance. That message is better than any generic line
   * this build could write, so it is the one case a server message is shown.
   */
  it('keeps the API’s own message when the failure carries no reason', () => {
    expect(connectFailureFromError(apiError(400, 'whatsapp_signup_failed'))).toEqual({
      failure: 'signup_failed',
      detail: 'Server-side message',
      requestId: REQUEST_ID,
    });
  });

  /**
   * A console running yesterday's bundle against an API that has published a
   * fifth reason. It must fall back, not hard-fail — the same reason
   * `ApiErrorSchema.code` stays a plain string.
   */
  it('falls back for a reason this build does not recognise', () => {
    const error = apiError(400, 'whatsapp_signup_failed', [
      { path: 'reason', message: 'something_meta_added_later' },
    ]);

    expect(connectFailureFromError(error).failure).toBe('signup_failed');
  });

  it.each([
    [409, 'conflict', 'conflict'],
    [429, 'rate_limited', 'rate_limited'],
    [502, 'upstream_unavailable', 'upstream_unavailable'],
    [403, 'forbidden', 'forbidden'],
  ])('maps %i %s, which carries no reason of its own', (status, code, expected) => {
    expect(connectFailureFromError(apiError(status, code))).toEqual({
      failure: expected,
      detail: null,
      requestId: REQUEST_ID,
    });
  });

  it('never shows the API’s message for a code it has its own words for', () => {
    expect(connectFailureFromError(apiError(409, 'conflict')).detail).toBeNull();
  });

  it.each([
    ['an unmapped API code', apiError(500, 'internal_error')],
    ['something that is not an API error at all', new Error('network down')],
  ])('reports %s as unknown rather than guessing', (_label, error) => {
    expect(connectFailureFromError(error).failure).toBe('unknown');
  });
});

describe('connect failure copy', () => {
  it('gives every failure a distinct heading and body', () => {
    const headings = WHATSAPP_CONNECT_FAILURES.map(
      (failure) => connectFailureCopy(failure).heading,
    );

    expect(new Set(headings).size).toBe(WHATSAPP_CONNECT_FAILURES.length);

    for (const failure of WHATSAPP_CONNECT_FAILURES) {
      expect(connectFailureCopy(failure).body.length).toBeGreaterThan(0);
    }
  });

  /**
   * Offering a retry that cannot work costs the user another trip through Meta to
   * be told the same thing.
   */
  it.each(['waba_mismatch', 'conflict', 'forbidden', 'sdk_unavailable'] as const)(
    'does not offer to re-run the flow for %s',
    (failure) => {
      expect(isConnectFailureRetryable(failure)).toBe(false);
    },
  );

  it.each(['code_expired', 'code_invalid', 'insufficient_permissions', 'cancelled'] as const)(
    'offers to re-run the flow for %s',
    (failure) => {
      expect(isConnectFailureRetryable(failure)).toBe(true);
    },
  );
});
