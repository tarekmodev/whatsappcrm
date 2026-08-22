import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AiConfigResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { BotReadinessPanel } from './BotReadinessPanel';
import { AiConfigForm } from './AiConfigForm';

const updateChatbotSettingsAction =
  vi.fn<(input: unknown) => Promise<{ status: 'success'; data: undefined }>>();

vi.mock('@/features/chatbot/chatbot.actions', () => ({
  updateChatbotSettingsAction: (input: unknown) => updateChatbotSettingsAction(input),
}));

/**
 * TAR-710's two rules that are behaviour rather than paint.
 *
 * **One boolean, one control.** The screen used to show an `On` status badge
 * above a checkbox labelled `On`, both describing whether the chatbot answers.
 * Whatever the readiness card says, only the settings form may set it.
 *
 * **The fields stay editable while a save is in flight**, because a save that is
 * running is not a reason to stop somebody correcting a typo they have just
 * spotted.
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

function renderForm(canWrite = true) {
  return render(
    <ToastProvider>
      <BotReadinessPanel readiness={CONFIG.readiness} />
      <AiConfigForm config={CONFIG} canWrite={canWrite} />
    </ToastProvider>,
  );
}

describe('AiConfigForm', () => {
  beforeEach(() => {
    updateChatbotSettingsAction.mockReset();
    updateChatbotSettingsAction.mockResolvedValue({ status: 'success', data: undefined });
  });

  it('offers exactly one control for whether the chatbot answers', () => {
    renderForm();

    // The readiness card is on screen too, and it may not be a second control.
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByRole('switch', { name: content.chatbot.enabledLabel })).toBeInTheDocument();
  });

  it('says "On" once, beside the control that sets it', () => {
    renderForm();

    // The readiness badge says "Answering", not "On": a summary that borrows the
    // control's words reads as a second control.
    expect(screen.getAllByText(content.chatbot.enabledOn)).toHaveLength(1);
    expect(screen.getByText(content.chatbot.readinessOn)).toBeInTheDocument();
  });

  it('flips the state it reports, and keeps the switch the only one that does', () => {
    renderForm();

    fireEvent.click(screen.getByRole('switch'));

    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByText(content.chatbot.enabledOff)).toBeInTheDocument();
  });

  it('leaves the fields editable while the save is in flight', async () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: content.chatbot.saveSettings }));

    await waitFor(() => {
      expect(updateChatbotSettingsAction).toHaveBeenCalled();
    });

    expect(screen.getByRole('switch')).toBeEnabled();
    expect(screen.getByLabelText(content.chatbot.maxTurnsLabel)).toBeEnabled();
  });

  it('shows the values as disabled controls, and no submit, without write access', () => {
    renderForm(false);

    expect(screen.getByRole('switch')).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: content.chatbot.saveSettings }),
    ).not.toBeInTheDocument();
  });
});
