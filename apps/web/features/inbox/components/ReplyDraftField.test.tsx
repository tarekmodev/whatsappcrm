import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { serviceWindowAt } from '@/features/inbox/service-window';
import { MessageComposer } from './MessageComposer';

/**
 * The shortcut mechanism, exercised through the whole composer rather than
 * through `ReplyDraftField` on its own — TAR-484's criteria are about what the
 * agent gets and what the customer does *not* get, and only the real form can
 * answer the second one.
 */

const sendMessageAction = vi.fn();

vi.mock('@/features/inbox/composer.actions', () => ({
  sendMessageAction: (...args: unknown[]) => sendMessageAction(...args) as unknown,
  listTemplatesAction: vi.fn(),
}));

vi.mock('@/lib/api/media-browser', () => ({
  uploadMedia: () => Promise.resolve({ mediaId: '0192f00a-0000-7000-8000-000000000a01' }),
}));

const CONVERSATION_ID = '0192f004-0000-7000-8000-000000000401';
const NOW = new Date('2026-08-12T12:00:00.000Z');
const OPEN_UNTIL = '2026-08-12T13:00:00.000Z';

const HOURS_BODY = "We're open Sunday to Thursday, 9am to 6pm.";
const HOLIDAY_BODY = "We're closed for the public holiday.";

function response(shortcut: string, title: string, body: string): CannedResponseResponse {
  return {
    id: `id${shortcut}`,
    shortcut,
    title,
    body,
    createdByUserId: null,
    createdAt: '2026-08-11T08:00:00.000Z',
    updatedAt: '2026-08-11T08:00:00.000Z',
  };
}

const LIBRARY: readonly CannedResponseResponse[] = [
  response('/holiday', 'Public holiday closure', HOLIDAY_BODY),
  response('/hours', 'Opening hours', HOURS_BODY),
  response('/wait', 'Handover to a colleague', 'Passing you to a colleague.'),
];

function renderComposer(cannedResponses: readonly CannedResponseResponse[] = LIBRARY) {
  return render(
    <ToastProvider>
      <MessageComposer
        conversationId={CONVERSATION_ID}
        serviceWindowExpiresAt={OPEN_UNTIL}
        initialWindow={serviceWindowAt(OPEN_UNTIL, NOW)}
        canSend
        isUnclaimed={false}
        cannedResponses={cannedResponses}
      />
    </ToastProvider>,
  );
}

function replyBox(): HTMLTextAreaElement {
  const box = fieldByLabel(content.composer.replyLabel);

  if (!(box instanceof HTMLTextAreaElement)) {
    throw new Error('The reply control is a textarea.');
  }

  return box;
}

/** Types `value` and leaves the caret where the agent would have left it. */
function type(value: string, caret: number = value.length): HTMLTextAreaElement {
  const box = replyBox();

  fireEvent.change(box, { target: { value } });
  box.setSelectionRange(caret, caret);
  fireEvent.select(box);

  return box;
}

function options(): readonly HTMLElement[] {
  return screen.queryAllByRole('option');
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

describe('opening the picker', () => {
  it('offers the responses a typed shortcut matches, shortcut and title', () => {
    renderComposer();
    type('/ho');

    expect(options().map((option) => option.textContent)).toEqual([
      '/holidayPublic holiday closure',
      '/hoursOpening hours',
    ]);
  });

  it('opens on the trigger alone', () => {
    renderComposer();
    type('/');

    expect(options()).toHaveLength(3);
  });

  it('opens on a token that starts a new word, not one inside a URL', () => {
    renderComposer();
    type('See https://acme.com/hours');

    expect(options()).toHaveLength(0);
  });

  it('shows nothing when the token matches no response', () => {
    renderComposer();
    type('/zzz');

    expect(options()).toHaveLength(0);
    expect(replyBox()).toHaveValue('/zzz');
  });

  it('closes once the caret leaves the token', () => {
    renderComposer();
    type('/ho');
    expect(options()).toHaveLength(2);

    type('/ho and more');

    expect(options()).toHaveLength(0);
  });

  it('points the textarea at the highlighted row', () => {
    renderComposer();
    const box = type('/ho');
    const [first] = options();

    expect(first).toBeDefined();
    expect(box).toHaveAttribute('aria-activedescendant', first?.id);
    expect(box).toHaveAttribute('aria-autocomplete', 'list');
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('announces how many responses match, politely', () => {
    renderComposer();
    type('/ho');

    // Queried by its text rather than by role: the attachment control below the
    // box is a live region too, and two of them is the ordinary state of this
    // form rather than something this test should be surprised by.
    expect(screen.getByText(content.composer.cannedMatchCount(2))).toHaveAttribute(
      'role',
      'status',
    );
  });
});

describe('inserting a response', () => {
  it('replaces the token with the full text and leaves the draft editable', () => {
    renderComposer();
    const box = type('Hi there /hours');

    fireEvent.keyDown(box, { key: 'Enter' });

    expect(box).toHaveValue(`Hi there ${HOURS_BODY}`);

    // Still an ordinary draft: the agent edits what was inserted.
    fireEvent.change(box, { target: { value: `Hi there ${HOURS_BODY} Anything else?` } });
    expect(box).toHaveValue(`Hi there ${HOURS_BODY} Anything else?`);
  });

  it('keeps the text after the caret, and puts the caret at the end of the insertion', () => {
    renderComposer();
    const box = type('Hi /ho — bye', 6);

    fireEvent.keyDown(box, { key: 'Enter' });

    expect(box).toHaveValue(`Hi ${HOLIDAY_BODY} — bye`);
    expect(box.selectionStart).toBe(3 + HOLIDAY_BODY.length);
  });

  it('does not send, and does not leave a newline behind, when Enter commits', () => {
    renderComposer();
    const box = type('/hours');

    fireEvent.keyDown(box, { key: 'Enter' });

    expect(sendMessageAction).not.toHaveBeenCalled();
    expect(box).toHaveValue(HOURS_BODY);
  });

  it('sends only when the agent presses Send', async () => {
    renderComposer();
    fireEvent.keyDown(type('/hours'), { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: content.composer.send }));

    await waitFor(() => {
      expect(sendMessageAction).toHaveBeenCalledWith(CONVERSATION_ID, expect.any(String), {
        type: 'text',
        body: HOURS_BODY,
      });
    });
  });

  it('commits the row the arrow keys moved to', () => {
    renderComposer();
    const box = type('/ho');

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(box).toHaveValue(HOURS_BODY);
  });

  it('wraps the highlight from the first row to the last', () => {
    renderComposer();
    const box = type('/ho');

    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(box).toHaveValue(HOURS_BODY);
  });

  it('commits on Tab', () => {
    renderComposer();
    const box = type('/hours');

    fireEvent.keyDown(box, { key: 'Tab' });

    expect(box).toHaveValue(HOURS_BODY);
  });

  it('commits the row that was clicked', () => {
    renderComposer();
    const box = type('/ho');
    const [, second] = options();

    expect(second).toBeDefined();
    fireEvent.click(second as HTMLElement);

    expect(box).toHaveValue(HOURS_BODY);
  });

  it('closes the picker once a response is in', () => {
    renderComposer();
    fireEvent.keyDown(type('/hours'), { key: 'Enter' });

    expect(options()).toHaveLength(0);
  });
});

describe('dismissing and degrading', () => {
  it('leaves the token as typed when Escape dismisses the picker', () => {
    renderComposer();
    const box = type('/hours');

    fireEvent.keyDown(box, { key: 'Escape' });

    expect(options()).toHaveLength(0);
    expect(box).toHaveValue('/hours');
  });

  it('stays dismissed for that token, and opens again for the next one', () => {
    renderComposer();
    const box = type('/hours');
    fireEvent.keyDown(box, { key: 'Escape' });

    type('/hours ');
    type('/hours /ho');

    expect(options()).toHaveLength(2);
  });

  it('sends the typed token itself when the agent dismisses and sends', async () => {
    renderComposer();
    fireEvent.keyDown(type('/hours'), { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: content.composer.send }));

    await waitFor(() => {
      expect(sendMessageAction).toHaveBeenCalledWith(CONVERSATION_ID, expect.any(String), {
        type: 'text',
        body: '/hours',
      });
    });
  });

  it('is the composer it always was when the tenant has no canned responses', () => {
    renderComposer([]);
    const box = type('/hours');

    expect(options()).toHaveLength(0);
    expect(box).not.toHaveAttribute('aria-autocomplete');
    expect(screen.queryByText(content.composer.cannedMatchCount(1))).not.toBeInTheDocument();
    expect(screen.getByText(content.composer.replyHint)).toBeInTheDocument();

    // Enter is a newline again, and nothing intercepts it.
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box).toHaveValue('/hours');
    expect(sendMessageAction).not.toHaveBeenCalled();
  });

  it('tells the agent the shortcut exists only when there is one to use', () => {
    renderComposer();

    expect(screen.getByText(content.composer.replyHintWithShortcuts('/'))).toBeInTheDocument();
  });
});
