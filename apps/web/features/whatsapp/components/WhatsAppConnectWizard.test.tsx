import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ConnectedWhatsAppBusinessAccountResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { MetaLoginResponse } from '../embedded-signup';
import { WhatsAppConnectWizard } from './WhatsAppConnectWizard';

/**
 * The connect wizard, exercised through the real flow modules with Meta's SDK and
 * the three server actions faked — so what these assert is "this run produces
 * this screen", not "this mock was called".
 *
 * Ported from `EmbeddedSignupPanel.test.tsx` when TAR-814 replaced that panel.
 * Every case it held is still here, because none of what it asserted changed:
 * step one *is* the Embedded Signup flow, and the two properties that suite
 * existed to protect are the two that matter most here too:
 *
 *   - the request goes out the *instant* both halves of Meta's answer are in
 *     hand, from whichever handler receives the second one. Meta does not order
 *     the two, and the authorisation is valid for about 30 seconds;
 *   - every published `details.reason` reaches a different message. A generic
 *     "something went wrong" is what the taxonomy exists to prevent.
 *
 * What is new is everything after step one: which number, whether Meta will let
 * it send, and whether anything arrives on it — plus the resume, which is the
 * one behaviour here with no server read behind it and therefore the one most
 * worth pinning down.
 *
 * `fireEvent` rather than `user-event`: the repo does not carry that package.
 */

/** Only the fields the flow reads. Nullable, because "not configured" is a state. */
interface StubWebEnv {
  metaAppId: string | null;
  metaEmbeddedSignupConfigId: string | null;
  metaGraphApiVersion: string;
  /** The unconfigured state's "Contact support" link, absent unless a test sets it. */
  supportEmail: string | null;
}

const env = vi.hoisted((): { webEnv: StubWebEnv } => ({
  webEnv: {
    metaAppId: '1234567890',
    metaEmbeddedSignupConfigId: '9876543210',
    metaGraphApiVersion: 'v23.0',
    supportEmail: null,
  },
}));

const transport = vi.hoisted(() => ({
  connect: vi.fn(),
  register: vi.fn(),
  findInbound: vi.fn(),
}));

vi.mock('@/lib/config/env', () => env);

vi.mock('../whatsapp.actions', () => ({
  connectWhatsAppAccountAction: transport.connect,
  registerWhatsAppNumberAction: transport.register,
  findWhatsAppInboundAction: transport.findInbound,
}));

/**
 * Meta's script is a network fetch the test environment must not make.
 *
 * The stub fires `onLoad` **once**, which is the part of `next/script` that
 * matters here: it keeps a module-level cache of the scripts it has inserted, so
 * a component that mounts a second time in the same page load gets no callback
 * at all. A stub that fired on every mount would hide exactly the bug the return
 * visit produces.
 */
const script = vi.hoisted(() => ({ hasFiredLoad: false, isBlocked: false }));

vi.mock('next/script', async () => {
  const { useEffect } = await import('react');

  return {
    default: function MockScript({ onLoad }: { onLoad?: () => void }) {
      useEffect(() => {
        if (script.hasFiredLoad || script.isBlocked) {
          return;
        }

        script.hasFiredLoad = true;
        onLoad?.();
      }, [onLoad]);

      return null;
    },
  };
});

const WABA_ID = '102290129340398';
const PHONE_NUMBER_ID = '106540352242922';
const SECOND_PHONE_NUMBER_ID = '106540352242923';
const CODE = 'AQD-authorisation-code';
const ACCOUNT_ID = '0192f100-0000-7000-8000-000000000001';
const NUMBER_ID = '0192f100-0000-7000-8000-000000000002';
const SECOND_NUMBER_ID = '0192f100-0000-7000-8000-000000000003';
const AT = '2026-08-11T10:00:00.000Z';

function connectedAccount(
  overrides: Partial<ConnectedWhatsAppBusinessAccountResponse> = {},
): ConnectedWhatsAppBusinessAccountResponse {
  return {
    id: ACCOUNT_ID,
    wabaId: WABA_ID,
    name: 'Northwind Traders',
    verificationStatus: 'verified',
    createdAt: AT,
    updatedAt: AT,
    accounts: [
      {
        id: NUMBER_ID,
        whatsappBusinessAccountId: ACCOUNT_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        displayPhoneNumber: '+966501234567',
        verifiedName: 'Northwind Support',
        qualityRating: 'green',
        status: 'connected',
        // The state a real connection lands in when Meta's automatic
        // registration did not take: receiving, and unable to send.
        registrationStatus: 'unregistered',
        registrationFailureReason: null,
        registeredAt: null,
        registrationAttemptedAt: null,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    ...overrides,
  };
}

/** A second number on the same WABA, which is what makes step two a question. */
function secondNumber(): ConnectedWhatsAppBusinessAccountResponse['accounts'][number] {
  return {
    ...connectedAccount().accounts[0]!,
    id: SECOND_NUMBER_ID,
    phoneNumberId: SECOND_PHONE_NUMBER_ID,
    displayPhoneNumber: '+966501234568',
    verifiedName: 'Northwind Sales',
  };
}

/** Captured from `FB.login`, so a test can answer as Meta would. */
let loginCallback: ((response: MetaLoginResponse) => void) | null = null;
const login = vi.fn((callback: (response: MetaLoginResponse) => void) => {
  loginCallback = callback;
});
const init = vi.fn();

function renderWizard() {
  return render(
    <ToastProvider>
      <WhatsAppConnectWizard />
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

/** Walks step one to its end, which is the precondition for every later step. */
function completeConnectStep(): void {
  clickConnect();
  postFromMeta('FINISH', FINISH_DATA);
  answerLogin({ authResponse: { code: CODE } });
}

/** One step's `<li>`, found by its title, so an assertion cannot match a neighbour. */
function stepByTitle(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title });
  const item = heading.closest('li');

  if (item === null) {
    throw new Error(`The step "${title}" is not inside a list item`);
  }

  return item;
}

/**
 * Lets every pending promise resolve and every effect run, under fake timers.
 *
 * Only the fake-timer block needs it: elsewhere `findBy*` does the same job, and
 * it cannot here because those helpers poll on the very timers that block has
 * taken control of.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const FINISH_DATA = { waba_id: WABA_ID, phone_number_id: PHONE_NUMBER_ID };
const WIZARD = content.whatsapp.wizard;

beforeEach(() => {
  vi.clearAllMocks();
  loginCallback = null;
  script.hasFiredLoad = false;
  script.isBlocked = false;
  env.webEnv = {
    metaAppId: '1234567890',
    metaEmbeddedSignupConfigId: '9876543210',
    metaGraphApiVersion: 'v23.0',
    supportEmail: null,
  };
  window.FB = { init, login };
  // Nothing is remembered between tests: the resume is a behaviour under test
  // here, not a fixture every other case inherits.
  window.sessionStorage.clear();
  transport.connect.mockResolvedValue({ status: 'success', account: connectedAccount() });
  transport.register.mockResolvedValue({
    status: 'success',
    data: {
      whatsappAccountId: NUMBER_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      registrationStatus: 'registered',
      registrationFailureReason: null,
      registeredAt: AT,
      registrationAttemptedAt: AT,
    },
  });
  transport.findInbound.mockResolvedValue({ status: 'success', data: { hasInbound: false } });
});

// ---------------------------------------------------------------------------
// Step one — Embedded Signup, unchanged in behaviour from the panel it replaced
// ---------------------------------------------------------------------------

describe('WhatsAppConnectWizard: connecting the account', () => {
  it('initialises Meta’s SDK with the configured app and pinned Graph version', async () => {
    renderWizard();

    await waitFor(() => {
      expect(init).toHaveBeenCalledWith(
        expect.objectContaining({ appId: '1234567890', version: 'v23.0' }),
      );
    });
  });

  it('launches the flow with a code response, not a client-side token', () => {
    renderWizard();
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
   * an effect-driven submit would fail it — and the step machine this wizard
   * added is exactly the kind of thing that could have introduced one.
   */
  it('posts the instant the code lands, with no confirmation step in between', () => {
    renderWizard();
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
    renderWizard();
    clickConnect();

    answerLogin({ authResponse: { code: CODE } });
    expect(transport.connect).not.toHaveBeenCalled();

    postFromMeta('FINISH', FINISH_DATA);

    expect(transport.connect).toHaveBeenCalledTimes(1);
  });

  it('ignores a message from a look-alike origin rather than claiming its WABA', () => {
    renderWizard();
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

  it('marks step one done and names what was connected', async () => {
    renderWizard();
    completeConnectStep();

    expect(
      await screen.findByText(WIZARD.steps.connect_account.done('Northwind Traders')),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(content.whatsapp.connectedToast('Northwind Traders')),
    ).toBeInTheDocument();
  });

  it.each([
    ['CANCEL', 'cancelled'],
    ['ERROR', 'meta_error'],
  ] as const)('ends the attempt with an explanation when Meta posts %s', (event, failure) => {
    renderWizard();
    clickConnect();

    postFromMeta(event);

    expect(screen.getByRole('alert')).toHaveTextContent(
      content.whatsapp.connectFailures[failure].heading,
    );
    // Not a spinner left running: the button is offered again.
    expect(screen.getByRole('button', { name: content.common.retry })).toBeInTheDocument();
  });

  it('treats a closed window with no authorisation as a cancellation', () => {
    renderWizard();
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
    renderWizard();
    completeConnectStep();

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
      renderWizard();
      completeConnectStep();

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
    renderWizard();
    completeConnectStep();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Meta reports no usable phone number on this WhatsApp Business Account.',
    );
  });

  it('draws step one as failed, so the marker agrees with the message', async () => {
    transport.connect.mockResolvedValue({
      status: 'error',
      report: { failure: 'rate_limited', detail: null, requestId: null },
    });
    renderWizard();
    completeConnectStep();

    const item = await screen
      .findByRole('alert')
      .then(() => stepByTitle(WIZARD.steps.connect_account.title));

    expect(item).toHaveAttribute('data-status', 'error');
    expect(within(item).getByText(WIZARD.statuses.error)).toBeInTheDocument();
  });

  it('offers no button at all when the console has no Meta app configured', () => {
    env.webEnv = { ...env.webEnv, metaAppId: null };
    renderWizard();

    expect(screen.getByText(content.whatsapp.unconfiguredHeading)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.whatsapp.connectButton }),
    ).not.toBeInTheDocument();
  });

  /**
   * TAR-515: the copy tells an admin to contact support, so the state offers it
   * rather than leaving them to find an address.
   */
  it('offers the configured support address as a real mailto link', () => {
    env.webEnv = { ...env.webEnv, metaAppId: null, supportEmail: 'help@operator.example' };
    renderWizard();

    expect(
      screen.getByRole('link', { name: content.whatsapp.unconfiguredSupportAction }),
    ).toHaveAttribute(
      'href',
      `mailto:help@operator.example?subject=${encodeURIComponent(content.whatsapp.unconfiguredSupportSubject)}`,
    );
  });

  it('keeps the explanation and drops the link where no address is configured', () => {
    env.webEnv = { ...env.webEnv, metaAppId: null, supportEmail: null };
    renderWizard();

    expect(screen.getByText(content.whatsapp.unconfiguredBody)).toBeInTheDocument();
    // A mailto to nowhere is worse than a sentence telling somebody to ask.
    expect(
      screen.queryByRole('link', { name: content.whatsapp.unconfiguredSupportAction }),
    ).toBeNull();
  });

  /**
   * The return visit. `next/script` fires `onLoad` once per page load, so a panel
   * that took its readiness from that callback alone left the button disabled for
   * the rest of the session — the page's only control, with no way back short of
   * a full reload. Readiness comes from `window.FB` instead, which is the thing
   * that actually decides whether `FB.login` can run.
   */
  it('still works on a return visit, when next/script does not fire onLoad again', () => {
    const first = renderWizard();

    expect(
      screen.getByRole('button', { name: content.whatsapp.connectButton }),
    ).not.toHaveAttribute('aria-disabled');

    first.unmount();
    init.mockClear();
    renderWizard();

    // Meta's script is cached, so nothing reported it a second time.
    expect(script.hasFiredLoad).toBe(true);
    // The wizard asked the SDK directly rather than waiting for a callback.
    expect(init).toHaveBeenCalledTimes(1);

    const button = screen.getByRole('button', { name: content.whatsapp.connectButton });

    expect(button).not.toHaveAttribute('aria-disabled');

    fireEvent.click(button);

    expect(login).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Steps two to four
// ---------------------------------------------------------------------------

describe('WhatsAppConnectWizard: the steps after connecting', () => {
  it('chooses the number for a WABA that has only one, rather than asking', async () => {
    renderWizard();
    completeConnectStep();

    expect(
      await screen.findByText(WIZARD.steps.select_number.done('+966501234567')),
    ).toBeInTheDocument();
    expect(stepByTitle(WIZARD.steps.select_number.title)).toHaveAttribute('data-status', 'done');
    expect(screen.queryByLabelText(WIZARD.steps.select_number.fieldLabel)).toBeNull();
  });

  /**
   * The whole reason step two exists. Left implicit, a workspace registers
   * whichever number sorted first and finds out months later that its team has
   * been answering from the wrong one.
   */
  it('asks which number to send from when the account holds more than one', async () => {
    transport.connect.mockResolvedValue({
      status: 'success',
      account: connectedAccount({
        accounts: [...connectedAccount().accounts, secondNumber()],
      }),
    });
    renderWizard();
    completeConnectStep();

    const picker = await screen.findByLabelText(WIZARD.steps.select_number.fieldLabel);

    expect(picker).toHaveValue('');
    expect(stepByTitle(WIZARD.steps.select_number.title)).toHaveAttribute('data-status', 'current');
    // Registration cannot be attempted against a number nobody has named.
    expect(stepByTitle(WIZARD.steps.register_number.title)).toHaveAttribute(
      'data-status',
      'upcoming',
    );

    fireEvent.change(picker, { target: { value: SECOND_NUMBER_ID } });

    expect(
      await screen.findByText(WIZARD.steps.select_number.done('+966501234568')),
    ).toBeInTheDocument();
  });

  it('reports a WABA that arrived with no numbers as a step that needs attention', async () => {
    transport.connect.mockResolvedValue({
      status: 'success',
      account: connectedAccount({ accounts: [] }),
    });
    renderWizard();
    completeConnectStep();

    expect(
      await screen.findByText(WIZARD.steps.select_number.noNumbersHeading),
    ).toBeInTheDocument();
    expect(stepByTitle(WIZARD.steps.select_number.title)).toHaveAttribute('data-status', 'error');
  });

  it('registers the chosen number by our id, never Meta’s', async () => {
    renderWizard();
    completeConnectStep();

    fireEvent.click(
      await screen.findByRole('button', { name: WIZARD.steps.register_number.action }),
    );

    await waitFor(() => {
      expect(transport.register).toHaveBeenCalledWith({ whatsappAccountId: NUMBER_ID });
    });
    expect(await screen.findByText(WIZARD.steps.register_number.done)).toBeInTheDocument();
  });

  /**
   * A refused registration answers `200` with the reason in the body, not an
   * error envelope. A wizard that only branched on a thrown error would draw
   * this as a success — which is the silent-inbox failure the whole second
   * status axis exists to prevent.
   */
  it('reads a refusal out of a successful response and gives it its own words', async () => {
    transport.register.mockResolvedValue({
      status: 'success',
      data: {
        whatsappAccountId: NUMBER_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        registrationStatus: 'failed',
        registrationFailureReason: 'pin_rejected',
        registeredAt: null,
        registrationAttemptedAt: AT,
      },
    });
    renderWizard();
    completeConnectStep();

    fireEvent.click(
      await screen.findByRole('button', { name: WIZARD.steps.register_number.action }),
    );

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(WIZARD.registrationFailures.pin_rejected.heading);
    expect(stepByTitle(WIZARD.steps.register_number.title)).toHaveAttribute('data-status', 'error');
    // Not retryable: the PIN has to change at Meta first, and pressing again
    // would fetch the same refusal.
    expect(
      screen.queryByRole('button', { name: WIZARD.steps.register_number.retryAction }),
    ).toBeNull();
  });

  it('sends a credential refusal back through Embedded Signup, not through a retry', async () => {
    transport.register.mockResolvedValue({
      status: 'success',
      data: {
        whatsappAccountId: NUMBER_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        registrationStatus: 'failed',
        registrationFailureReason: 'credential_rejected',
        registeredAt: null,
        registrationAttemptedAt: AT,
      },
    });
    renderWizard();
    completeConnectStep();

    fireEvent.click(
      await screen.findByRole('button', { name: WIZARD.steps.register_number.action }),
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: WIZARD.steps.register_number.reconnectAction,
      }),
    );

    // Back to the top, with nothing remembered: fresh access is the only fix.
    expect(
      await screen.findByRole('button', { name: content.whatsapp.connectButton }),
    ).toBeInTheDocument();
    expect(stepByTitle(WIZARD.steps.connect_account.title)).toHaveAttribute(
      'data-status',
      'current',
    );
  });

  it('finishes the flow when a message reaches the number', async () => {
    transport.findInbound.mockResolvedValue({ status: 'success', data: { hasInbound: true } });
    renderWizard();
    completeConnectStep();

    fireEvent.click(
      await screen.findByRole('button', { name: WIZARD.steps.register_number.action }),
    );
    fireEvent.click(await screen.findByRole('button', { name: WIZARD.steps.test_send.action }));

    expect(await screen.findByText(WIZARD.completeHeading)).toBeInTheDocument();
    expect(stepByTitle(WIZARD.steps.test_send.title)).toHaveAttribute('data-status', 'done');
    // The steps stay on screen: a congratulation that swallowed the list would
    // take the way back with it.
    expect(stepByTitle(WIZARD.steps.connect_account.title)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Resuming
// ---------------------------------------------------------------------------

/**
 * The behaviour with no server read behind it, and therefore the one worth
 * pinning down hardest: there is no tenant-facing `GET` for a connected WABA, so
 * a reload restores from `sessionStorage` or restores nothing.
 */
describe('WhatsAppConnectWizard: resuming', () => {
  it('comes back to the step it was left on after a reload', async () => {
    const first = renderWizard();

    completeConnectStep();
    await screen.findByText(WIZARD.steps.select_number.done('+966501234567'));

    // A reload, as far as this component can tell: the tree goes away and a new
    // one mounts against the same storage.
    first.unmount();
    renderWizard();

    expect(stepByTitle(WIZARD.steps.connect_account.title)).toHaveAttribute('data-status', 'done');
    expect(stepByTitle(WIZARD.steps.select_number.title)).toHaveAttribute('data-status', 'done');
    expect(stepByTitle(WIZARD.steps.register_number.title)).toHaveAttribute(
      'data-status',
      'current',
    );
    expect(
      screen.getByText(WIZARD.steps.connect_account.done('Northwind Traders')),
    ).toBeInTheDocument();
  });

  /**
   * The restored connection is the last answer the API gave, not a fact
   * re-checked on arrival — and there is no read that could re-check it. A
   * wizard that presented remembered state as current state silently would be
   * the wrong kind of confident.
   */
  it('says the connection was remembered rather than just showing it', async () => {
    const first = renderWizard();

    completeConnectStep();
    await screen.findByText(WIZARD.steps.select_number.done('+966501234567'));

    first.unmount();
    renderWizard();

    expect(screen.getByText(WIZARD.restoredNotice)).toBeInTheDocument();
  });

  it('does not claim to have remembered a connection made in this sitting', async () => {
    renderWizard();
    completeConnectStep();

    await screen.findByText(WIZARD.steps.select_number.done('+966501234567'));

    expect(screen.queryByText(WIZARD.restoredNotice)).toBeNull();
  });

  /**
   * A value that has been outside the type system — a stale build wrote it, a
   * devtools console edited it. Discarded rather than repaired: starting from
   * the top is recoverable, and rendering half a restored connection is not.
   */
  it('starts from the top rather than trusting a payload it cannot parse', () => {
    window.sessionStorage.setItem(
      'whatsappcrm.whatsapp-wizard',
      JSON.stringify({ version: 1, account: { wabaId: 42 }, selectedNumberId: 'nope' }),
    );
    renderWizard();

    expect(stepByTitle(WIZARD.steps.connect_account.title)).toHaveAttribute(
      'data-status',
      'current',
    );
    expect(screen.queryByText(WIZARD.restoredNotice)).toBeNull();
  });

  it('forgets everything when the reader starts again', async () => {
    transport.findInbound.mockResolvedValue({ status: 'success', data: { hasInbound: true } });
    renderWizard();
    completeConnectStep();

    fireEvent.click(
      await screen.findByRole('button', { name: WIZARD.steps.register_number.action }),
    );
    fireEvent.click(await screen.findByRole('button', { name: WIZARD.steps.test_send.action }));
    fireEvent.click(await screen.findByRole('button', { name: WIZARD.startAgain }));

    expect(stepByTitle(WIZARD.steps.connect_account.title)).toHaveAttribute(
      'data-status',
      'current',
    );
    expect(window.sessionStorage.getItem('whatsappcrm.whatsapp-wizard')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Waits that must end
// ---------------------------------------------------------------------------

/**
 * Every wait in this flow ends in an explanation and a button, because the
 * alternative is a disabled control that never says why.
 */
describe('WhatsAppConnectWizard: waits that must end', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Only half of Meta's answer arrives. Every way that happens is silent by
   * design — a message from a host outside the trusted domain, an event Meta
   * renamed, an extension that ate the post — because an unrecognised message
   * must not end a run that is still going. This is what gives "still going" an
   * expiry date.
   */
  it('calls off a run that only ever receives the code', () => {
    renderWizard();
    clickConnect();

    answerLogin({ authResponse: { code: CODE } });

    expect(transport.connect).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });

    const alert = screen.getByRole('alert');

    expect(alert).toHaveTextContent(content.whatsapp.connectFailures.timed_out.heading);
    // Not "you cancelled": nobody did, and saying so sends them looking for the
    // wrong mistake.
    expect(alert).not.toHaveTextContent(content.whatsapp.connectFailures.cancelled.heading);
    expect(screen.getByRole('button', { name: content.common.retry })).toBeInTheDocument();
    expect(transport.connect).not.toHaveBeenCalled();
  });

  it('leaves a run that completed in time alone', () => {
    renderWizard();
    completeConnectStep();

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * Meta's script never arrives and never reports an error either — a blocker or
   * a privacy setting that drops the request silently. Without this the button is
   * a spinner with nothing behind it.
   */
  it('stops waiting for a script that is not coming, and says what to do', () => {
    script.isBlocked = true;
    delete window.FB;
    renderWizard();

    // Queried by pattern, not by exact name: a pending button folds the spinner's
    // own label into its accessible name.
    expect(
      screen.getByRole('button', { name: new RegExp(content.whatsapp.connectButton) }),
    ).toHaveAttribute('aria-disabled', 'true');

    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      content.whatsapp.connectFailures.sdk_unavailable.heading,
    );
  });

  /**
   * The inbound check is the one poll in this flow, and the thing it waits for
   * happens on somebody's phone. It stops — and stopping is not a failure: the
   * step keeps the number the reader still has to write to, and adds a warning
   * rather than turning red over a message that has simply not been sent yet.
   */
  it('stops watching the inbox after a minute, and keeps the instructions', async () => {
    renderWizard();
    completeConnectStep();
    // Testing Library's own async helpers poll on timers this block has faked,
    // so the settling is driven explicitly instead: `advanceTimersByTimeAsync`
    // flushes the microtask queue, which is where a mocked action's answer is.
    await settle();

    fireEvent.click(screen.getByRole('button', { name: WIZARD.steps.register_number.action }));
    await settle();

    fireEvent.click(screen.getByRole('button', { name: WIZARD.steps.test_send.action }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByText(WIZARD.steps.test_send.notSeenHeading)).toBeInTheDocument();
    // Still the step to do, not a step that went wrong.
    expect(stepByTitle(WIZARD.steps.test_send.title)).toHaveAttribute('data-status', 'current');
    expect(screen.getByRole('button', { name: WIZARD.steps.test_send.action })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );

    const asks = transport.findInbound.mock.calls.length;

    // And it really has stopped: nothing more goes out after the deadline.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(transport.findInbound.mock.calls).toHaveLength(asks);
  });
});
