import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AiConfigResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { ChatbotSettingsForm } from './ChatbotSettingsForm';

const updateChatbotSettingsAction =
  vi.fn<(input: unknown) => Promise<{ status: string; data?: unknown; message?: string }>>();

vi.mock('@/features/chatbot/chatbot.actions', () => ({
  updateChatbotSettingsAction: (input: unknown) => updateChatbotSettingsAction(input),
}));

/**
 * The three commit behaviours this page has to keep apart (TAR-813), plus the
 * two rules TAR-710 established that survived the rebuild.
 *
 * **The master switch writes on its own** and everything else waits for Save.
 * Getting that backwards in either direction is the expensive bug: a switch that
 * waits leaves the chatbot answering customers after somebody turned it off, and
 * a field that does not wait writes half-typed prompts to live configuration.
 *
 * **The save bar appears only for the fields it speaks for.** It is not in the
 * DOM until one of them changes, and it must never be brought on by anything
 * that has already saved itself.
 *
 * **One boolean, one control**, and **the fields stay editable while a save is
 * in flight** — both TAR-710's, both still true.
 */

const CONFIG: AiConfigResponse = {
  isEnabled: true,
  model: null,
  minConfidence: 0.6,
  maxBotTurns: 3,
  systemPrompt: null,
  handoffMessage: null,
  handoffKeywords: [],
  availableModels: [],
  readiness: { ready: true, indexedDocumentCount: 2, blockers: [] },
  updatedAt: '2026-08-01T09:05:00.000Z',
};

function renderForm({ canWrite = true, isInPlan = true } = {}) {
  return render(
    <ToastProvider>
      <ChatbotSettingsForm config={CONFIG} canWrite={canWrite} isInPlan={isInPlan} />
    </ToastProvider>,
  );
}

function saveBar() {
  return screen.queryByRole('region', { name: content.chatbot.saveBarLabel });
}

beforeEach(() => {
  updateChatbotSettingsAction.mockReset();
  updateChatbotSettingsAction.mockResolvedValue({ status: 'success', data: undefined });
});

describe('the master switch', () => {
  it('is the only control for whether the chatbot answers', () => {
    renderForm();

    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(
      screen.getByRole('switch', { name: content.chatbot.ruleEnabledName }),
    ).toBeInTheDocument();
  });

  it('saves on flip, carrying nothing but its own field', async () => {
    // `UpdateAiConfigInput` is `.partial()`, so a lone `isEnabled` is legal — and
    // sending the rest along would commit whatever half-typed values happen to be
    // on screen when somebody reaches for the switch.
    renderForm();

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(updateChatbotSettingsAction).toHaveBeenCalledWith({ isEnabled: false });
    });
  });

  it('does not bring on the save bar, because it has already saved', async () => {
    renderForm();

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(updateChatbotSettingsAction).toHaveBeenCalled();
    });

    expect(saveBar()).not.toBeInTheDocument();
  });

  it('snaps back and says why when the write is refused', async () => {
    // Optimistic and then wrong is worse than slow: the switch is the mode the
    // product is in, and it may not go on claiming a state the server rejected.
    updateChatbotSettingsAction.mockResolvedValue({
      status: 'error',
      message: 'The chatbot is not included in this plan.',
    });

    renderForm();

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeChecked();
    });

    // Inline and persistent, never a toast: the message has to stay while the
    // reader is looking at the control that produced it.
    expect(screen.getByText('The chatbot is not included in this plan.')).toBeInTheDocument();
  });
});

describe('the saved-together fields', () => {
  it('shows no save bar until something changes', () => {
    renderForm();

    expect(saveBar()).not.toBeInTheDocument();
  });

  it('counts the changes it is holding', () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(content.chatbot.ruleTurnsName), {
      target: { value: '4' },
    });

    expect(screen.getByText(content.chatbot.unsavedChanges(1))).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(content.chatbot.systemPromptLabel), {
      target: { value: 'Be brief.' },
    });

    expect(screen.getByText(content.chatbot.unsavedChanges(2))).toBeInTheDocument();
  });

  it('writes nothing until Save is pressed', () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(content.chatbot.systemPromptLabel), {
      target: { value: 'Be brief.' },
    });

    expect(updateChatbotSettingsAction).not.toHaveBeenCalled();
  });

  it('sends every field except the switch’s, in one request', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(content.chatbot.systemPromptLabel), {
      target: { value: 'Be brief.' },
    });
    fireEvent.click(screen.getByRole('button', { name: content.chatbot.saveSettings }));

    await waitFor(() => {
      expect(updateChatbotSettingsAction).toHaveBeenCalledTimes(1);
    });

    const [input] = updateChatbotSettingsAction.mock.calls[0] ?? [];

    expect(input).toMatchObject({ systemPrompt: 'Be brief.', maxBotTurns: 3 });
    expect(input).not.toHaveProperty('isEnabled');
  });

  it('puts the bar away once the change is saved', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(content.chatbot.systemPromptLabel), {
      target: { value: 'Be brief.' },
    });
    fireEvent.click(screen.getByRole('button', { name: content.chatbot.saveSettings }));

    await waitFor(() => {
      expect(saveBar()).not.toBeInTheDocument();
    });
  });

  it('puts every field back where it was when the change is cancelled', () => {
    renderForm();

    const prompt = screen.getByLabelText(content.chatbot.systemPromptLabel);

    fireEvent.change(prompt, { target: { value: 'Be brief.' } });
    fireEvent.click(screen.getByRole('button', { name: content.chatbot.discardChanges }));

    expect(prompt).toHaveValue('');
    expect(saveBar()).not.toBeInTheDocument();
  });

  it('leaves the fields editable while the save is in flight', async () => {
    // A save that is running is not a reason to stop somebody correcting a typo
    // they have just spotted (TAR-710).
    renderForm();

    fireEvent.change(screen.getByLabelText(content.chatbot.ruleTurnsName), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: content.chatbot.saveSettings }));

    await waitFor(() => {
      expect(updateChatbotSettingsAction).toHaveBeenCalled();
    });

    expect(screen.getByLabelText(content.chatbot.ruleTurnsName)).toBeEnabled();
  });

  it('refuses a reply limit outside the contract’s bounds, without a round trip', () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(content.chatbot.ruleTurnsName), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: content.chatbot.saveSettings }));

    expect(updateChatbotSettingsAction).not.toHaveBeenCalled();
    expect(screen.getByLabelText(content.chatbot.ruleTurnsName)).toHaveFocus();
  });
});

describe('a reader who may not write', () => {
  it('sees the values as disabled controls, and no way to save', () => {
    // Hiding the settings would leave them unable to see what the chatbot is
    // doing at all, which is the opposite of what a read-only role needs.
    renderForm({ canWrite: false });

    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByLabelText(content.chatbot.ruleTurnsName)).toBeDisabled();
    expect(screen.getByText(content.chatbot.settingsReadOnlyNotice)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.chatbot.saveSettings }),
    ).not.toBeInTheDocument();
  });

  it('is told when the plan rather than the role is the reason', () => {
    renderForm({ canWrite: false, isInPlan: false });

    expect(screen.getByText(content.chatbot.upsellNotice)).toBeInTheDocument();
  });
});

describe('the rule ladder', () => {
  it('shows the gate nobody can configure, rather than leaving it out', () => {
    // `agent_requested` is why the bot goes quiet mid-conversation. An admin
    // debugging that needs to see the rule, not deduce it from the inbox.
    renderForm();

    expect(screen.getByText(content.chatbot.ruleThreadName)).toBeInTheDocument();
    expect(screen.getByText(content.chatbot.ruleThreadNote)).toBeInTheDocument();
  });

  it('says what the current reply limit does, not just what the field is called', () => {
    renderForm();

    expect(screen.getByText(content.chatbot.ruleTurnsClause(3))).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(content.chatbot.ruleTurnsName), {
      target: { value: '7' },
    });

    expect(screen.getByText(content.chatbot.ruleTurnsClause(7))).toBeInTheDocument();
  });
});
