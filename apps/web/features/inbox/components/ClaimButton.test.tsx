import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { ClaimButton } from './ClaimButton';

/**
 * TAR-20's second acceptance criterion at the control level: claiming a
 * conversation is one deliberate action, and releasing it is the same control
 * pointing the other way.
 */

const claimConversationAction = vi.fn();
const releaseConversationAction = vi.fn();

vi.mock('@/features/inbox/inbox.actions', () => ({
  claimConversationAction: (...args: unknown[]) => claimConversationAction(...args) as unknown,
  releaseConversationAction: (...args: unknown[]) => releaseConversationAction(...args) as unknown,
}));

const CONVERSATION_ID = '0192f004-0000-7000-8000-000000000404';
const CONTACT = 'Fatima Al-Zahra';

function renderButton(isMine: boolean) {
  return render(
    <ToastProvider>
      <ClaimButton conversationId={CONVERSATION_ID} contactName={CONTACT} isMine={isMine} />
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

describe('ClaimButton', () => {
  it('names the conversation it acts on, so a list of "Claim" is not ambiguous', () => {
    renderButton(false);

    expect(
      screen.getByRole('button', { name: content.inbox.claimAria(CONTACT) }),
    ).toBeInTheDocument();
  });

  it('claims an unheld conversation and confirms which one', async () => {
    renderButton(false);

    fireEvent.click(screen.getByRole('button', { name: content.inbox.claimAria(CONTACT) }));

    await waitFor(() => {
      expect(claimConversationAction).toHaveBeenCalledWith(CONVERSATION_ID);
    });
    expect(await screen.findByText(content.inbox.claimSuccess(CONTACT))).toBeInTheDocument();
    expect(releaseConversationAction).not.toHaveBeenCalled();
  });

  it('releases one the signed-in user already holds', async () => {
    renderButton(true);

    fireEvent.click(screen.getByRole('button', { name: content.inbox.releaseAria(CONTACT) }));

    await waitFor(() => {
      expect(releaseConversationAction).toHaveBeenCalledWith(CONVERSATION_ID);
    });
    expect(await screen.findByText(content.inbox.releaseSuccess(CONTACT))).toBeInTheDocument();
    expect(claimConversationAction).not.toHaveBeenCalled();
  });

  it('reports a refusal inline rather than only as a toast that disappears', async () => {
    claimConversationAction.mockResolvedValue({
      status: 'error',
      message: 'Your role does not include conversation:assign.',
      requestId: 'req-1',
    });

    renderButton(false);

    fireEvent.click(screen.getByRole('button', { name: content.inbox.claimAria(CONTACT) }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your role does not include conversation:assign.',
    );
  });

  it('does not fire twice when it is double-clicked', async () => {
    let resolve: ((value: unknown) => void) | undefined;

    claimConversationAction.mockReturnValue(
      new Promise((settle) => {
        resolve = settle;
      }),
    );

    renderButton(false);

    const button = screen.getByRole('button', { name: content.inbox.claimAria(CONTACT) });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(claimConversationAction).toHaveBeenCalledTimes(1);

    resolve?.({ status: 'success', data: { contactName: CONTACT } });
    await waitFor(() => {
      expect(button).not.toHaveAttribute('aria-disabled');
    });
  });
});
