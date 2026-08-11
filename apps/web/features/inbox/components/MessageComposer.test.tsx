import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { serviceWindowAt } from '@/features/inbox/service-window';
import { MessageComposer } from './MessageComposer';

const sendMessageAction = vi.fn();

vi.mock('@/features/inbox/composer.actions', () => ({
  sendMessageAction: (...args: unknown[]) => sendMessageAction(...args) as unknown,
  listTemplatesAction: vi.fn(),
}));

const CONVERSATION_ID = '0192f004-0000-7000-8000-000000000401';
const NOW = new Date('2026-08-12T12:00:00.000Z');
const OPEN_UNTIL = '2026-08-12T13:00:00.000Z';

function renderComposer({
  expiresAt = OPEN_UNTIL,
  canSend = true,
}: { expiresAt?: string | null; canSend?: boolean } = {}) {
  return render(
    <ToastProvider>
      <MessageComposer
        conversationId={CONVERSATION_ID}
        serviceWindowExpiresAt={expiresAt}
        initialWindow={serviceWindowAt(expiresAt, NOW)}
        canSend={canSend}
      />
    </ToastProvider>,
  );
}

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: content.composer.send });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  sendMessageAction.mockReset();
  sendMessageAction.mockResolvedValue({ status: 'success', data: undefined });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('inside the 24-hour window', () => {
  it('sends the trimmed message and clears the draft', async () => {
    renderComposer();

    fireEvent.change(fieldByLabel(content.composer.replyLabel), {
      target: { value: '  On its way.  ' },
    });
    fireEvent.click(sendButton());

    await waitFor(() => {
      expect(sendMessageAction).toHaveBeenCalledWith(CONVERSATION_ID, expect.any(String), {
        type: 'text',
        body: 'On its way.',
      });
    });

    await waitFor(() => {
      expect(fieldByLabel(content.composer.replyLabel)).toHaveValue('');
    });
    expect(screen.getByText(content.composer.sendSuccess)).toBeInTheDocument();
  });

  it('carries an Idempotency-Key that is a UUID', async () => {
    renderComposer();

    fireEvent.change(fieldByLabel(content.composer.replyLabel), { target: { value: 'Hello' } });
    fireEvent.click(sendButton());

    await waitFor(() => {
      expect(sendMessageAction).toHaveBeenCalledTimes(1);
    });
    // The API refuses anything else, and refuses it naming a header nobody typed.
    expect(sendMessageAction.mock.calls[0]?.[1]).toMatch(UUID_PATTERN);
  });

  it('refuses an empty message where the agent can still fix it', () => {
    renderComposer();

    fireEvent.change(fieldByLabel(content.composer.replyLabel), { target: { value: '   ' } });
    fireEvent.click(sendButton());

    expect(screen.getByText(content.composer.problems['body-required'])).toBeInTheDocument();
    expect(sendMessageAction).not.toHaveBeenCalled();
  });

  it('keeps what was typed when the send fails', async () => {
    sendMessageAction.mockResolvedValue({
      status: 'error',
      message: 'WhatsApp could not deliver that.',
      requestId: 'req-1',
    });

    renderComposer();

    fireEvent.change(fieldByLabel(content.composer.replyLabel), {
      target: { value: 'Worth keeping.' },
    });
    fireEvent.click(sendButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('WhatsApp could not deliver that.');
    });
    expect(fieldByLabel(content.composer.replyLabel)).toHaveValue('Worth keeping.');
  });

  it('caps the field at the length the contract enforces', () => {
    renderComposer();

    expect(fieldByLabel(content.composer.replyLabel)).toHaveAttribute('maxLength', '4096');
  });
});

describe('the double-send guard', () => {
  it('sends once for a rapid double-click', async () => {
    renderComposer();

    fireEvent.change(fieldByLabel(content.composer.replyLabel), { target: { value: 'Only once' } });

    const button = sendButton();

    // Both in the same tick, which is what a real double-click is: reading
    // `isPending` from state would see `false` twice.
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => {
      expect(sendMessageAction).toHaveBeenCalledTimes(1);
    });
  });

  it('retries an unchanged draft on the same key, so the API replays instead of resending', async () => {
    sendMessageAction.mockResolvedValue({
      status: 'error',
      message: content.form.genericSubmitError,
      requestId: null,
    });

    renderComposer();

    fireEvent.change(fieldByLabel(content.composer.replyLabel), { target: { value: 'Same text' } });
    fireEvent.click(sendButton());
    await waitFor(() => {
      expect(sendMessageAction).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(sendButton());
    await waitFor(() => {
      expect(sendMessageAction).toHaveBeenCalledTimes(2);
    });

    expect(sendMessageAction.mock.calls[1]?.[1]).toBe(sendMessageAction.mock.calls[0]?.[1]);
  });

  it('mints a new key once the draft changes, so a fixed typo is not refused as a reuse', async () => {
    sendMessageAction.mockResolvedValue({
      status: 'error',
      message: content.form.genericSubmitError,
      requestId: null,
    });

    renderComposer();

    fireEvent.change(fieldByLabel(content.composer.replyLabel), {
      target: { value: 'Teh invoice' },
    });
    fireEvent.click(sendButton());
    await waitFor(() => {
      expect(sendMessageAction).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(fieldByLabel(content.composer.replyLabel), {
      target: { value: 'The invoice' },
    });
    fireEvent.click(sendButton());
    await waitFor(() => {
      expect(sendMessageAction).toHaveBeenCalledTimes(2);
    });

    // Same key with a different body is `idempotency_key_reused` — a refusal the
    // agent could do nothing about.
    expect(sendMessageAction.mock.calls[1]?.[1]).not.toBe(sendMessageAction.mock.calls[0]?.[1]);
  });
});

describe('outside the 24-hour window', () => {
  it.each([
    ['the window has expired', '2026-08-12T11:00:00.000Z'],
    ['the thread never had one', null],
  ])('offers only a template when %s', (_case, expiresAt) => {
    renderComposer({ expiresAt });

    expect(screen.getByText(content.composer.windowClosedHeading)).toBeInTheDocument();
    expect(fieldByLabel(content.composer.replyLabel)).toBeDisabled();
    expect(sendButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: content.composer.useTemplate })).toBeEnabled();
  });
});

describe('the window closing mid-conversation', () => {
  it('switches the composer over without a page refresh, and says so', async () => {
    renderComposer({ expiresAt: '2026-08-12T12:00:30.000Z' });

    fireEvent.change(fieldByLabel(content.composer.replyLabel), {
      target: { value: 'Half typed' },
    });
    expect(fieldByLabel(content.composer.replyLabel)).toBeEnabled();

    await act(async () => {
      vi.setSystemTime(new Date('2026-08-12T12:00:31.000Z'));
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(screen.getByText(content.composer.windowClosedHeading)).toBeInTheDocument();
    expect(screen.getByText(content.composer.windowJustClosedToast)).toBeInTheDocument();
    // The draft survives: removing the box would throw away what was typed.
    expect(fieldByLabel(content.composer.replyLabel)).toHaveValue('Half typed');
    expect(fieldByLabel(content.composer.replyLabel)).toBeDisabled();
  });
});

describe('without conversation:send', () => {
  it('explains itself rather than rendering nothing', () => {
    renderComposer({ canSend: false });

    expect(screen.getByText(content.composer.sendNotPermitted)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: content.composer.send })).not.toBeInTheDocument();
  });
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
