import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { routes } from '@/lib/routes';
import type { ActionResult } from '@/lib/actions/result';
import type { PeopleCaller } from '../role-assignment';
import { InviteAgentDialog } from './InviteAgentDialog';

/**
 * TAR-37's seat-limit criterion: "backed by the enforced API error (not a UI-only
 * guess)".
 *
 * That phrase is the whole of what these cases pin, and it has two halves. The
 * upgrade path must appear **when the API refuses** — and it must *not* appear
 * before that, because the console does not hold the authoritative seat count. A
 * dialog that pre-checked one would refuse invitations the API would have allowed
 * the moment somebody accepted or withdrew one in another tab.
 *
 * `fireEvent` rather than `user-event`: the repo does not carry that package. The
 * mock is typed against the action's real signature, so a test cannot go on
 * passing while the action it stands in for changes shape.
 */
const inviteAgentAction = vi.fn<(input: unknown) => Promise<ActionResult<{ email: string }>>>();

vi.mock('../people.actions', () => ({
  inviteAgentAction: (input: unknown) => inviteAgentAction(input),
}));

const CALLER: PeopleCaller = {
  userId: '0192f001-0000-7000-8000-000000000103',
  role: 'admin',
  canSetRole: true,
};

beforeEach(() => {
  inviteAgentAction.mockReset();
});

describe('InviteAgentDialog', () => {
  it('offers no upgrade path before anything has been refused', () => {
    renderDialog();

    expect(screen.queryByText(content.people.seatLimitUpgradeBody)).not.toBeInTheDocument();
  });

  it('shows the API’s own refusal, which is the copy that states the numbers', async () => {
    inviteAgentAction.mockResolvedValue({
      status: 'error',
      message: 'Every seat on your plan is in use (6 of 6).',
      requestId: null,
      code: 'plan_limit_exceeded',
    });

    renderDialog();
    submit();

    expect(
      await screen.findByText('Every seat on your plan is in use (6 of 6).'),
    ).toBeInTheDocument();
  });

  it('adds the way out once the seat cap is what refused it', async () => {
    inviteAgentAction.mockResolvedValue({
      status: 'error',
      message: 'Every seat on your plan is in use (6 of 6).',
      requestId: null,
      code: 'plan_limit_exceeded',
    });

    renderDialog();
    submit();

    expect(await screen.findByText(content.people.seatLimitUpgradeBody)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: content.people.seatLimitUpgradeLink })).toHaveAttribute(
      'href',
      routes.settingsBilling(),
    );
  });

  /**
   * The code is branched on, not the message: an API message is server-owned copy
   * and would break this affordance the moment it was reworded or translated.
   */
  it('does not offer an upgrade for a refusal that is not about seats', async () => {
    inviteAgentAction.mockResolvedValue({
      status: 'error',
      message: 'A user with that email already exists in this workspace.',
      requestId: null,
      code: 'conflict',
    });

    renderDialog();
    submit();

    await screen.findByText('A user with that email already exists in this workspace.');

    expect(screen.queryByText(content.people.seatLimitUpgradeBody)).not.toBeInTheDocument();
  });

  it('keeps the address the user typed, so a refusal costs no retyping', async () => {
    inviteAgentAction.mockResolvedValue({
      status: 'error',
      message: 'Every seat on your plan is in use (6 of 6).',
      requestId: null,
      code: 'plan_limit_exceeded',
    });

    renderDialog();
    submit('newcomer@northwind.example');

    await screen.findByText(content.people.seatLimitUpgradeBody);

    expect(fieldByLabel(content.people.inviteEmailLabel)).toHaveValue('newcomer@northwind.example');
  });

  it('clears the upgrade path when the next attempt is allowed', async () => {
    inviteAgentAction.mockResolvedValueOnce({
      status: 'error',
      message: 'Every seat on your plan is in use (6 of 6).',
      requestId: null,
      code: 'plan_limit_exceeded',
    });
    inviteAgentAction.mockResolvedValueOnce({
      status: 'success',
      data: { email: 'newcomer@northwind.example' },
    });

    const { onClose } = renderDialog();

    submit();
    await screen.findByText(content.people.seatLimitUpgradeBody);

    submit();
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});

function renderDialog(): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();

  render(
    <ToastProvider>
      <InviteAgentDialog teams={[]} caller={CALLER} onClose={onClose} />
    </ToastProvider>,
  );

  return { onClose };
}

function submit(email = 'newcomer@northwind.example'): void {
  fireEvent.change(fieldByLabel(content.people.inviteEmailLabel), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: content.people.inviteSubmit }));
}
