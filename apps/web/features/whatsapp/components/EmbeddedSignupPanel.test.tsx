import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConnectedWhatsAppBusinessAccountResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { MetaLoginResponse } from '../embedded-signup';
import { EmbeddedSignupPanel } from './EmbeddedSignupPanel';

/**
 * The Embedded Signup panel, exercised through the real flow module with Meta's
 * SDK and the server action faked — so what these assert is "this run produces
 * this screen", not "this mock was called".
 *
 * The two that matter most:
 *
 *   - the request goes out the *instant* both halves of Meta's answer are in
 *     hand, from whichever handler receives the second one. Meta does not order
 *     the two, and the authorisation is valid for about 30 seconds;
 *   - every published `details.reason` reaches a different message. A generic
 *     "something went wrong" is what the taxonomy exists to prevent.
 *
 * `fireEvent` rather than `user-event`: the repo does not carry that package.
 */

/** Only the fields the flow reads. Nullable, because "not configured" is a state. */
interface StubWebEnv {
  metaAppId: string | null;
  metaEmbeddedSignupConfigId: string | null;
  metaGraphApiVersion: string;
}

const env = vi.hoisted((): { webEnv: StubWebEnv } => ({
  webEnv: {
    metaAppId: '1234567890',
    metaEmbeddedSignupConfigId: '9876543210',
    metaGraphApiVersion: 'v23.0',
  },
}));

const transport = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock('@/lib/config/env', () => env);

vi.mock('../whatsapp.actions', () => ({ connectWhatsAppAccountAction: transport.connect }));

// Meta's script is a network fetch the test environment must not make. The stub
// reports itself loaded, which is exactly what `next/script` does once it is.
vi.mock('next/script', async () => {
  const { useEffect } = await import('react');

  return {
    default: function MockScript({ onLoad }: { onLoad?: () => void }) {
      useEffect(() => {
        onLoad?.();
      }, [onLoad]);

      return null;
    },
  };
});

const WABA_ID = '102290129340398';
const PHONE_NUMBER_ID = '106540352242922';
const CODE = 'AQD-authorisation-code';

const CONNECTED: ConnectedWhatsAppBusinessAccountResponse = {
  id: '0192f100-0000-7000-8000-000000000001',
  wabaId: WABA_ID,
  name: 'Northwind Traders',
  verificationStatus: 'verified',
  createdAt: '2026-08-11T10:00:00.000Z',
  updatedAt: '2026-08-11T10:00:00.000Z',
  accounts: [
    {
      id: '0192f100-0000-7000-8000-000000000002',
      whatsappBusinessAccountId: '0192f100-0000-7000-8000-000000000001',
      phoneNumberId: PHONE_NUMBER_ID,
      displayPhoneNumber: '+966501234567',
      verifiedName: 'Northwind Support',
      qualityRating: 'green',
      status: 'connected',
      createdAt: '2026-08-11T10:00:00.000Z',
      updatedAt: '2026-08-11T10:00:00.000Z',
    },
  ],
};

/** Captured from `FB.login`, so a test can answer as Meta would. */
let loginCallback: ((response: MetaLoginResponse) => void) | null = null;
const login = vi.fn((callback: (response: MetaLoginResponse) => void) => {
  loginCallback = callback;
});
const init = vi.fn();

function renderPanel() {
  return render(
    <ToastProvider>
      <EmbeddedSignupPanel />
    </ToastProvider>,
  );
}

function clickConnect(): void {
  fireEvent.click(screen.getByRole('button', { name: content.whatsapp.connectButton }));
}

/** As Meta posts it: a JSON string, from a facebook.com origin. */
function postFromMeta(event: string, data?: Record<string, string>): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://www.facebook.com',
        data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, ...(data && { data }) }),
      }),
    );
  });
}

function answerLogin(response: MetaLoginResponse): void {
  act(() => {
    loginCallback?.(response);
  });
}

const FINISH_DATA = { waba_id: WABA_ID, phone_number_id: PHONE_NUMBER_ID };

beforeEach(() => {
  vi.clearAllMocks();
  loginCallback = null;
  env.webEnv = {
    metaAppId: '1234567890',
    metaEmbeddedSignupConfigId: '9876543210',
    metaGraphApiVersion: 'v23.0',
  };
  window.FB = { init, login };
  transport.connect.mockResolvedValue({ status: 'success', account: CONNECTED });
});

describe('EmbeddedSignupPanel', () => {
  it('initialises Meta’s SDK with the configured app and pinned Graph version', async () => {
    renderPanel();

    await waitFor(() => {
      expect(init).toHaveBeenCalledWith(
        expect.objectContaining({ appId: '1234567890', version: 'v23.0' }),
      );
    });
  });

  it('launches the flow with a code response, not a client-side token', () => {
    renderPanel();
    clickConnect();

    expect(login).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        config_id: '9876543210',
        response_type: 'code',
        override_default_response_type: true,
      }),
    );
  });

  /**
   * The acceptance criterion, stated as a test: nothing sits between the second
   * half of Meta's answer and the request. `toHaveBeenCalledTimes` is asserted
   * with no `waitFor` in front of it precisely so a confirmation step, a form or
   * an effect-driven submit would fail it.
   */
  it('posts the instant the code lands, with no confirmation step in between', () => {
    renderPanel();
    clickConnect();

    postFromMeta('FINISH', FINISH_DATA);
    expect(transport.connect).not.toHaveBeenCalled();

    answerLogin({ authResponse: { code: CODE } });

    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.connect).toHaveBeenCalledWith({
      code: CODE,
      wabaId: WABA_ID,
      phoneNumberId: PHONE_NUMBER_ID,
    });
  });

  /** Meta does not promise an order, and losing the bet costs the whole run. */
  it('posts just as promptly when Meta’s message arrives after the callback', () => {
    renderPanel();
    clickConnect();

    answerLogin({ authResponse: { code: CODE } });
    expect(transport.connect).not.toHaveBeenCalled();

    postFromMeta('FINISH', FINISH_DATA);

    expect(transport.connect).toHaveBeenCalledTimes(1);
  });

  it('ignores a message from a look-alike origin rather than claiming its WABA', () => {
    renderPanel();
    clickConnect();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://evilfacebook.com',
          data: JSON.stringify({
            type: 'WA_EMBEDDED_SIGNUP',
            event: 'FINISH',
            data: { waba_id: '999999999999999' },
          }),
        }),
      );
    });
    answerLogin({ authResponse: { code: CODE } });

    expect(transport.connect).not.toHaveBeenCalled();
  });

  it('shows the connected account and its numbers from the response body', async () => {
    renderPanel();
    clickConnect();
    postFromMeta('FINISH', FINISH_DATA);
    answerLogin({ authResponse: { code: CODE } });

    expect(await screen.findByText('Northwind Traders')).toBeInTheDocument();
    expect(screen.getByText('+966501234567')).toBeInTheDocument();
    expect(screen.getByText('Northwind Support')).toBeInTheDocument();
    expect(screen.getByText(content.whatsapp.verificationStatuses.verified)).toBeInTheDocument();
    expect(
      screen.getByText(content.whatsapp.connectedToast('Northwind Traders')),
    ).toBeInTheDocument();
  });

  it.each([
    ['CANCEL', 'cancelled'],
    ['ERROR', 'meta_error'],
  ] as const)('ends the attempt with an explanation when Meta posts %s', (event, failure) => {
    renderPanel();
    clickConnect();

    postFromMeta(event);

    expect(screen.getByRole('alert')).toHaveTextContent(
      content.whatsapp.connectFailures[failure].heading,
    );
    // Not a spinner left running: the button is offered again.
    expect(screen.getByRole('button', { name: content.common.retry })).toBeInTheDocument();
  });

  it('treats a closed window with no authorisation as a cancellation', () => {
    renderPanel();
    clickConnect();

    answerLogin({ authResponse: null });

    expect(screen.getByRole('alert')).toHaveTextContent(
      content.whatsapp.connectFailures.cancelled.heading,
    );
  });

  /**
   * One case per published reason, plus the codes that carry none. Each has to
   * reach its own words — that is the whole point of `details.reason`.
   */
  it.each([
    'code_expired',
    'code_invalid',
    'insufficient_permissions',
    'waba_mismatch',
    'conflict',
    'rate_limited',
    'upstream_unavailable',
  ] as const)('renders the message %s earns, and no other', async (failure) => {
    transport.connect.mockResolvedValue({
      status: 'error',
      report: { failure, detail: null, requestId: 'req-9' },
    });
    renderPanel();
    clickConnect();
    postFromMeta('FINISH', FINISH_DATA);
    answerLogin({ authResponse: { code: CODE } });

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(content.whatsapp.connectFailures[failure].heading);
    expect(alert).toHaveTextContent(content.whatsapp.connectFailures[failure].body);
    expect(alert).toHaveTextContent(content.errors.correlationId('req-9'));
  });

  it.each(['waba_mismatch', 'conflict'] as const)(
    'does not offer to re-run the flow for %s, which re-running cannot fix',
    async (failure) => {
      transport.connect.mockResolvedValue({
        status: 'error',
        report: { failure, detail: null, requestId: null },
      });
      renderPanel();
      clickConnect();
      postFromMeta('FINISH', FINISH_DATA);
      answerLogin({ authResponse: { code: CODE } });

      await screen.findByRole('alert');

      expect(screen.queryByRole('button', { name: content.common.retry })).not.toBeInTheDocument();
    },
  );

  it('shows the API’s own message when the failure carries no reason', async () => {
    transport.connect.mockResolvedValue({
      status: 'error',
      report: {
        failure: 'signup_failed',
        detail: 'Meta reports no usable phone number on this WhatsApp Business Account.',
        requestId: null,
      },
    });
    renderPanel();
    clickConnect();
    postFromMeta('FINISH', FINISH_DATA);
    answerLogin({ authResponse: { code: CODE } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Meta reports no usable phone number on this WhatsApp Business Account.',
    );
  });

  it('offers no button at all when the console has no Meta app configured', () => {
    env.webEnv = { ...env.webEnv, metaAppId: null };
    renderPanel();

    expect(screen.getByText(content.whatsapp.unconfiguredHeading)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.whatsapp.connectButton }),
    ).not.toBeInTheDocument();
  });
});
