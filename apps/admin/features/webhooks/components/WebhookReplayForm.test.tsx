import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdminWebhookEventReplayResponse } from '@whatsappcrm/contracts';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { fieldByLabel } from '@/lib/testing/field-queries';
import type { ActionResult } from '@/lib/actions/result';
import { content } from '~/content/en';
import { WebhookReplayForm } from './WebhookReplayForm';

const replayWebhookEventAction =
  vi.fn<(input: unknown) => Promise<ActionResult<AdminWebhookEventReplayResponse>>>();

vi.mock('../webhooks.actions', () => ({
  replayWebhookEventAction: (input: unknown) => replayWebhookEventAction(input),
}));

const EVENT_ID = '0192f00a-0000-7000-8000-00000000c001';
const SECOND_ID = '0192f00a-0000-7000-8000-00000000c002';

function replayed(
  overrides: Partial<AdminWebhookEventReplayResponse> = {},
): AdminWebhookEventReplayResponse {
  return {
    id: EVENT_ID,
    provider: 'whatsapp',
    status: 'received',
    parkedError: 'unknown_phone_number_id: 15550001111',
    replayedAt: '2026-08-23T09:00:00.000Z',
    ...overrides,
  };
}

const renderForm = () =>
  render(
    <ToastProvider>
      <WebhookReplayForm />
    </ToastProvider>,
  );

const typeId = (value: string) =>
  fireEvent.change(fieldByLabel(content.webhooks.idLabel), { target: { value } });

const send = () => fireEvent.click(screen.getByRole('button', { name: content.webhooks.submit }));

describe('WebhookReplayForm', () => {
  beforeEach(() => {
    replayWebhookEventAction.mockReset();
  });

  it('names the runbook, because a console with no list is otherwise a dead end', () => {
    renderForm();

    expect(screen.getByRole('link', { name: content.webhooks.runbookLink })).toBeInTheDocument();
  });

  it.each([
    ['', content.webhooks.idRequiredError],
    ['nonsense', content.webhooks.idInvalidError],
  ])('refuses %j without a round trip', async (value, message) => {
    renderForm();

    if (value !== '') {
      typeId(value);
    }

    send();

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(replayWebhookEventAction).not.toHaveBeenCalled();
  });

  /**
   * The copy must not overclaim: the API is explicit that `replayedAt` is when
   * the reset committed, not when the event was reprocessed.
   */
  it('sends a well-formed id and reports the reset without promising more', async () => {
    replayWebhookEventAction.mockResolvedValue({ status: 'success', data: replayed() });
    renderForm();
    typeId(EVENT_ID);
    send();

    await waitFor(() => {
      expect(replayWebhookEventAction).toHaveBeenCalledWith({ webhookEventId: EVENT_ID });
    });
    expect(await screen.findByText(content.webhooks.replayedNotice)).toBeInTheDocument();
  });

  /**
   * The session log is the whole answer to "there is no list endpoint": an
   * operator working a batch needs to see what they have already done.
   */
  it('keeps every replay of the session, newest first, and clears the field', async () => {
    replayWebhookEventAction.mockResolvedValueOnce({ status: 'success', data: replayed() });
    renderForm();
    typeId(EVENT_ID);
    send();

    await screen.findByText(EVENT_ID);
    expect(fieldByLabel(content.webhooks.idLabel)).toHaveValue('');

    replayWebhookEventAction.mockResolvedValueOnce({
      status: 'success',
      data: replayed({ id: SECOND_ID }),
    });
    typeId(SECOND_ID);
    send();

    await screen.findByText(SECOND_ID);

    const entries = screen.getAllByText(/^0192f00a-0000-7000-8000-00000000c00[12]$/);

    expect(entries[0]).toHaveTextContent(SECOND_ID);
    expect(entries[1]).toHaveTextContent(EVENT_ID);
  });

  /**
   * Only the WhatsApp sweeper runs today, so a `billing` event reset to
   * `received` waits for a worker that does not exist. That is a fact about the
   * platform rather than a failed request, so it is said beside the result.
   */
  it('warns when nothing will collect the event it just reset', async () => {
    replayWebhookEventAction.mockResolvedValue({
      status: 'success',
      data: replayed({ provider: 'billing' }),
    });
    renderForm();
    typeId(EVENT_ID);
    send();

    expect(await screen.findByText(content.webhooks.providerNotSweptNotice)).toBeInTheDocument();
  });

  it('does not warn for the provider that is swept', async () => {
    replayWebhookEventAction.mockResolvedValue({ status: 'success', data: replayed() });
    renderForm();
    typeId(EVENT_ID);
    send();

    await screen.findByText(content.webhooks.replayedNotice);
    expect(screen.queryByText(content.webhooks.providerNotSweptNotice)).not.toBeInTheDocument();
  });

  /**
   * The API's own sentence, verbatim. "Already processed" and "already received"
   * mean different next steps, and the generic line would send an operator
   * mid-incident to psql to find out what they had already been told.
   */
  it('shows the API’s refusal and keeps the id that caused it', async () => {
    replayWebhookEventAction.mockResolvedValue({
      status: 'error',
      message: 'This webhook event is processed, not parked, so there is nothing to replay.',
      requestId: 'req-9',
    });
    renderForm();
    typeId(EVENT_ID);
    send();

    expect(
      await screen.findByText(
        'This webhook event is processed, not parked, so there is nothing to replay.',
      ),
    ).toBeInTheDocument();
    expect(fieldByLabel(content.webhooks.idLabel)).toHaveValue(EVENT_ID);
  });

  /**
   * A refusal about one id must not sit above a field error about a different one
   * the console never sent anywhere.
   */
  it('clears the previous failure when the next submit is refused client-side', async () => {
    replayWebhookEventAction.mockResolvedValue({
      status: 'error',
      message: content.webhooks.notFoundError,
      requestId: null,
    });
    renderForm();
    typeId(EVENT_ID);
    send();
    await screen.findByText(content.webhooks.notFoundError);

    typeId('nonsense');
    send();

    expect(await screen.findByText(content.webhooks.idInvalidError)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(content.webhooks.notFoundError)).not.toBeInTheDocument();
    });
  });
});
