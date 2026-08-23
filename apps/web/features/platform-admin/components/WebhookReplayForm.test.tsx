import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdminWebhookEventReplayResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { fieldByLabel } from '@/lib/testing/field-queries';
import type { ActionResult } from '@/lib/actions/result';
import { WebhookReplayForm } from './WebhookReplayForm';

const replayWebhookEventAction =
  vi.fn<(input: unknown) => Promise<ActionResult<AdminWebhookEventReplayResponse>>>();

vi.mock('../platform-admin.actions', () => ({
  replayWebhookEventAction: (input: unknown) => replayWebhookEventAction(input),
}));

const copy = content.platformAdmin.webhookEvents;
const EVENT_ID = '0192f00a-0000-7000-8000-00000000c001';

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

function renderForm() {
  return render(
    <ToastProvider>
      <WebhookReplayForm />
    </ToastProvider>,
  );
}

const typeId = (value: string) =>
  fireEvent.change(fieldByLabel(copy.idLabel), { target: { value } });

describe('WebhookReplayForm', () => {
  beforeEach(() => {
    replayWebhookEventAction.mockReset();
  });

  it('says there is no way to list parked events, so the field is not a dead end', () => {
    renderForm();

    expect(screen.getByText(copy.noListNotice)).toBeInTheDocument();
    expect(fieldByLabel(copy.idLabel)).toBeInTheDocument();
  });

  it('refuses an empty id without a round trip', async () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: copy.submit }));

    expect(await screen.findByText(copy.idRequiredError)).toBeInTheDocument();
    expect(replayWebhookEventAction).not.toHaveBeenCalled();
  });

  /**
   * `IdSchema` is what the API validates the path parameter with, so a paste that
   * lost a character is caught here rather than as a refusal from the server.
   */
  it('refuses a malformed id without a round trip', async () => {
    renderForm();
    typeId('nonsense');

    fireEvent.click(screen.getByRole('button', { name: copy.submit }));

    expect(await screen.findByText(copy.idInvalidError)).toBeInTheDocument();
    expect(replayWebhookEventAction).not.toHaveBeenCalled();
  });

  it('sends a well-formed id and reports what came back', async () => {
    replayWebhookEventAction.mockResolvedValue({ status: 'success', data: replayed() });
    renderForm();
    typeId(EVENT_ID);

    fireEvent.click(screen.getByRole('button', { name: copy.submit }));

    await waitFor(() => {
      expect(replayWebhookEventAction).toHaveBeenCalledWith({ webhookEventId: EVENT_ID });
    });

    // The reason being recovered stays on screen: a toast leaves, and this is
    // what makes a run against several events read as a report.
    expect(await screen.findByText('unknown_phone_number_id: 15550001111')).toBeInTheDocument();
    expect(screen.getByText(copy.resultHeading)).toBeInTheDocument();
  });

  /**
   * Only the WhatsApp sweeper runs today, so an event from another provider sits
   * at `received` until a worker for it exists. That is a fact about the
   * platform rather than a failed request, so it is said beside the result.
   */
  it('warns when nothing will collect the event it just reset', async () => {
    replayWebhookEventAction.mockResolvedValue({
      status: 'success',
      data: replayed({ provider: 'billing' }),
    });
    renderForm();
    typeId(EVENT_ID);

    fireEvent.click(screen.getByRole('button', { name: copy.submit }));

    expect(await screen.findByText(copy.providerNotSweptNotice)).toBeInTheDocument();
  });

  it('does not warn for the provider that is swept', async () => {
    replayWebhookEventAction.mockResolvedValue({ status: 'success', data: replayed() });
    renderForm();
    typeId(EVENT_ID);

    fireEvent.click(screen.getByRole('button', { name: copy.submit }));

    await screen.findByText(copy.resultHeading);
    expect(screen.queryByText(copy.providerNotSweptNotice)).not.toBeInTheDocument();
  });

  /**
   * The API's own sentence, verbatim: "already processed" and "already received"
   * mean different next steps, and the generic line would send an operator
   * mid-incident to psql to find out what they had already been told.
   */
  it('shows the API’s refusal rather than a generic line', async () => {
    replayWebhookEventAction.mockResolvedValue({
      status: 'error',
      message: 'This webhook event is processed, not parked, so there is nothing to replay.',
      requestId: 'req-9',
    });
    renderForm();
    typeId(EVENT_ID);

    fireEvent.click(screen.getByRole('button', { name: copy.submit }));

    expect(
      await screen.findByText(
        'This webhook event is processed, not parked, so there is nothing to replay.',
      ),
    ).toBeInTheDocument();
    // The id stays, so the operator can see what they sent.
    expect(fieldByLabel(copy.idLabel)).toHaveValue(EVENT_ID);
  });

  /**
   * A refusal about one id must not sit above a field error about a different
   * one the console never sent anywhere.
   */
  it('clears the previous failure when the next submit is refused client-side', async () => {
    replayWebhookEventAction.mockResolvedValue({
      status: 'error',
      message: 'No stored webhook event has that id.',
      requestId: null,
    });
    renderForm();
    typeId(EVENT_ID);
    fireEvent.click(screen.getByRole('button', { name: copy.submit }));
    await screen.findByText('No stored webhook event has that id.');

    typeId('nonsense');
    fireEvent.click(screen.getByRole('button', { name: copy.submit }));

    expect(await screen.findByText(copy.idInvalidError)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('No stored webhook event has that id.')).not.toBeInTheDocument();
    });
  });
});
