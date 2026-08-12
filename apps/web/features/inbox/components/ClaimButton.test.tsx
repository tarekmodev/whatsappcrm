import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ConversationHold } from '@/features/inbox/conversation-hold';
import { ClaimButton } from './ClaimButton';

/**
 * TAR-20's second acceptance criterion at the control level, and the finding
 * that came out of reviewing it: taking a thread off the colleague working it is
 * not the same act as picking one out of the shared pool, and must not look like
 * it. TAR-186 made them different writes as well — the claim compares and sets,
 * the take-over stays blind — so the confirmation is now in front of the one
 * that genuinely cannot be refused.
 */

const claimConversationAction = vi.fn();
const releaseConversationAction = vi.fn();

vi.mock('@/features/inbox/inbox.actions', () => ({
  claimConversationAction: (...args: unknown[]) => claimConversationAction(...args) as unknown,
  releaseConversationAction: (...args: unknown[]) => releaseConversationAction(...args) as unknown,
}));

const CONVERSATION_ID = '0192f004-0000-7000-8000-000000000404';
const CONTACT = 'Fatima Al-Zahra';

function renderButton(hold: ConversationHold) {
  return render(
    <ToastProvider>
      <ClaimButton conversationId={CONVERSATION_ID} contactName={CONTACT} hold={hold} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  claimConversationAction.mockReset();
  releaseConversationAction.mockReset();
  claimConversationAction.mockResolvedValue({
    status: 'success',
    data: { contactName: CONTACT },
  });
  releaseConversationAction.mockResolvedValue({
    status: 'success',
    data: { contactName: CONTACT },
  });
});

describe('ClaimButton — unclaimed', () => {
  it('names the conversation it acts on, so a list of "Claim" is not ambiguous', () => {
    renderButton({ state: 'unclaimed' });

    expect(
      screen.getByRole('button', { name: content.inbox.claimAria(CONTACT) }),
    ).toBeInTheDocument();
  });

  it('claims straight away — nobody is holding it, so there is nothing to confirm', async () => {
    renderButton({ state: 'unclaimed' });

    fireEvent.click(screen.getByRole('button', { name: content.inbox.claimAria(CONTACT) }));

    await waitFor(() => {
      expect(claimConversationAction).toHaveBeenCalledWith(CONVERSATION_ID);
    });
    expect(await screen.findByText(content.inbox.claimSuccess(CONTACT))).toBeInTheDocument();
    expect(releaseConversationAction).not.toHaveBeenCalled();
  });

  it('does not fire twice when it is double-clicked', async () => {
    let resolve: ((value: unknown) => void) | undefined;

    claimConversationAction.mockReturnValue(
      new Promise((settle) => {
        resolve = settle;
      }),
    );

    renderButton({ state: 'unclaimed' });

    const button = screen.getByRole('button', { name: content.inbox.claimAria(CONTACT) });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(claimConversationAction).toHaveBeenCalledTimes(1);

    resolve?.({ status: 'success', data: { contactName: CONTACT } });
    await waitFor(() => {
      expect(button).not.toHaveAttribute('aria-disabled');
    });
  });

  it('reports a lost race inline rather than only as a toast that disappears', async () => {
    // The refusal an agent will actually meet since TAR-186: the claim compares
    // and sets, so a colleague who was a moment quicker keeps the thread.
    claimConversationAction.mockResolvedValue({
      status: 'error',
      message: 'Somebody else claimed this conversation first.',
      requestId: 'req-1',
    });

    renderButton({ state: 'unclaimed' });

    fireEvent.click(screen.getByRole('button', { name: content.inbox.claimAria(CONTACT) }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Somebody else claimed this conversation first.',
    );
  });
});

describe('ClaimButton — mine', () => {
  it('releases one the signed-in user already holds, with no confirmation', async () => {
    renderButton({ state: 'mine' });

    fireEvent.click(screen.getByRole('button', { name: content.inbox.releaseAria(CONTACT) }));

    await waitFor(() => {
      expect(releaseConversationAction).toHaveBeenCalledWith(CONVERSATION_ID);
    });
    expect(await screen.findByText(content.inbox.releaseSuccess(CONTACT))).toBeInTheDocument();
    expect(claimConversationAction).not.toHaveBeenCalled();
  });
});

describe('ClaimButton — held by somebody else', () => {
  const HELD: ConversationHold = { state: 'theirs', holderName: 'Liang Wei' };

  it('offers a take-over, not a claim, and names who it is taken from', () => {
    renderButton(HELD);

    expect(
      screen.getByRole('button', { name: content.inbox.takeOverAria(CONTACT, 'Liang Wei') }),
    ).toBeInTheDocument();
    // The word matters: "Claim" is what the shared pool gets.
    expect(screen.queryByRole('button', { name: content.inbox.claimAria(CONTACT) })).toBeNull();
  });

  it('writes nothing on the first click — the confirmation comes first', async () => {
    renderButton(HELD);

    fireEvent.click(
      screen.getByRole('button', { name: content.inbox.takeOverAria(CONTACT, 'Liang Wei') }),
    );

    // The dialog is a lazy chunk; wait for it rather than for a fixed tick.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(claimConversationAction).not.toHaveBeenCalled();
  });

  it('says who holds it and that they will not be told', async () => {
    renderButton(HELD);

    fireEvent.click(
      screen.getByRole('button', { name: content.inbox.takeOverAria(CONTACT, 'Liang Wei') }),
    );
    await screen.findByRole('dialog');

    expect(screen.getByText(content.inbox.takeOverBody(CONTACT, 'Liang Wei'))).toBeInTheDocument();
  });

  it('takes it over once confirmed, and says who it came from', async () => {
    renderButton(HELD);

    fireEvent.click(
      screen.getByRole('button', { name: content.inbox.takeOverAria(CONTACT, 'Liang Wei') }),
    );
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: content.inbox.takeOverConfirm }));

    await waitFor(() => {
      expect(claimConversationAction).toHaveBeenCalledWith(CONVERSATION_ID);
    });
    expect(
      await screen.findByText(content.inbox.takeOverSuccess(CONTACT, 'Liang Wei')),
    ).toBeInTheDocument();
  });

  it('cancels without writing anything', async () => {
    renderButton(HELD);

    fireEvent.click(
      screen.getByRole('button', { name: content.inbox.takeOverAria(CONTACT, 'Liang Wei') }),
    );
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: content.common.cancel }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(claimConversationAction).not.toHaveBeenCalled();
  });

  it('still names a holder whose id the directory could not resolve', async () => {
    renderButton({ state: 'theirs', holderName: null });

    const label = content.inbox.takeOverAria(CONTACT, content.inbox.unresolvedHolder);

    fireEvent.click(screen.getByRole('button', { name: label }));
    await screen.findByRole('dialog');

    expect(
      screen.getByText(content.inbox.takeOverBody(CONTACT, content.inbox.unresolvedHolder)),
    ).toBeInTheDocument();
  });
});
