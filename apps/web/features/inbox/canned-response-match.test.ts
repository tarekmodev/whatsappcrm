import { describe, expect, it } from 'vitest';
import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import {
  insertCannedResponse,
  matchCannedResponses,
  shortcutTokenBefore,
} from '@/features/inbox/canned-response-match';

function response(
  shortcut: string,
  title: string,
  body = `Body of ${shortcut}`,
): CannedResponseResponse {
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
  response('/shipping', 'Delivery times'),
  response('/hours', 'Opening hours'),
  response('/holiday', 'Public holiday closure'),
  response('/wait', 'Handover to a colleague'),
];

describe('shortcutTokenBefore', () => {
  it('finds a token at the start of the draft', () => {
    expect(shortcutTokenBefore('/ho', 3)).toEqual({ start: 0, query: '/ho' });
  });

  it('finds a token after a space', () => {
    expect(shortcutTokenBefore('Hi there /ho', 12)).toEqual({ start: 9, query: '/ho' });
  });

  it('finds a token after a newline', () => {
    expect(shortcutTokenBefore('Hi\n/ho', 6)).toEqual({ start: 3, query: '/ho' });
  });

  it('treats the bare trigger as a token, so the first keystroke opens the picker', () => {
    expect(shortcutTokenBefore('/', 1)).toEqual({ start: 0, query: '/' });
  });

  it('ignores a slash inside a URL', () => {
    expect(shortcutTokenBefore('See https://acme.com/hours', 26)).toBeNull();
  });

  it('ignores a slash glued to the end of a word', () => {
    expect(shortcutTokenBefore('either/or', 9)).toBeNull();
  });

  it('reads only the text before the caret', () => {
    // The agent has moved back into a finished sentence; `/hours` is behind them.
    expect(shortcutTokenBefore('/hours and more', 11)).toBeNull();
  });

  it('stops at whitespace, so a finished token is no longer being typed', () => {
    expect(shortcutTokenBefore('/hours ', 7)).toBeNull();
  });

  it('accepts the token an agent typed in capitals', () => {
    expect(shortcutTokenBefore('/Ho', 3)).toEqual({ start: 0, query: '/Ho' });
  });

  it('has no token in a draft with no trigger', () => {
    expect(shortcutTokenBefore('hours', 5)).toBeNull();
  });
});

describe('matchCannedResponses', () => {
  it('offers every response for the bare trigger, by shortcut', () => {
    expect(matchCannedResponses(LIBRARY, '/').map((item) => item.shortcut)).toEqual([
      '/holiday',
      '/hours',
      '/shipping',
      '/wait',
    ]);
  });

  it('keeps both responses sharing a prefix, so the agent picks rather than guesses', () => {
    expect(matchCannedResponses(LIBRARY, '/ho').map((item) => item.shortcut)).toEqual([
      '/holiday',
      '/hours',
    ]);
  });

  it('matches case-insensitively, as `citext` does in the database', () => {
    expect(matchCannedResponses(LIBRARY, '/HOU').map((item) => item.shortcut)).toEqual(['/hours']);
  });

  it('falls back to a title substring, after the shortcut matches', () => {
    // `/wait` is titled "Handover to a colleague"; nothing starts with `/hand`.
    expect(matchCannedResponses(LIBRARY, '/hand').map((item) => item.shortcut)).toEqual(['/wait']);
  });

  it('ranks shortcut matches above title matches', () => {
    const library = [...LIBRARY, response('/faq', 'How to reach us out of hours')];

    expect(matchCannedResponses(library, '/hou').map((item) => item.shortcut)).toEqual([
      '/hours',
      '/faq',
    ]);
  });

  it('lists a response that matches both ways once', () => {
    const library = [response('/hours', 'Opening hours')];

    expect(matchCannedResponses(library, '/hour')).toHaveLength(1);
  });

  it('returns nothing when the token matches neither shortcut nor title', () => {
    expect(matchCannedResponses(LIBRARY, '/zzz')).toEqual([]);
  });

  it('returns nothing for an empty library', () => {
    expect(matchCannedResponses([], '/ho')).toEqual([]);
  });

  it('caps the list', () => {
    const library = Array.from({ length: 20 }, (_unused, index) =>
      response(`/h${String(index).padStart(2, '0')}`, `Response ${String(index)}`),
    );

    expect(matchCannedResponses(library, '/h')).toHaveLength(8);
  });

  it('orders independently of the order it was handed', () => {
    const reversed = [...LIBRARY].reverse();

    expect(matchCannedResponses(reversed, '/').map((item) => item.shortcut)).toEqual(
      matchCannedResponses(LIBRARY, '/').map((item) => item.shortcut),
    );
  });
});

describe('insertCannedResponse', () => {
  it('replaces the token and leaves the rest of the draft alone', () => {
    const draft = 'Hi there /ho — see you';
    const token = shortcutTokenBefore(draft, 12);

    if (token === null) {
      throw new Error('The draft holds a token; the test above this one says so.');
    }

    expect(insertCannedResponse(draft, token, 12, "We're open 9 to 6.")).toEqual({
      draft: "Hi there We're open 9 to 6. — see you",
      caret: 27,
    });
  });

  it('puts the caret at the end of the inserted body', () => {
    const result = insertCannedResponse('/ho', { start: 0, query: '/ho' }, 3, 'Opening hours.');

    expect(result.draft).toBe('Opening hours.');
    expect(result.caret).toBe(result.draft.length);
  });

  it('does not truncate a body that pushes the draft past the send ceiling', () => {
    // `buildFreeFormSend` refuses an over-long draft on submit; silently
    // shortening a canned response here would send something nobody wrote.
    const long = 'x'.repeat(5000);
    const result = insertCannedResponse('/ho', { start: 0, query: '/ho' }, 3, long);

    expect(result.draft).toHaveLength(5000);
  });
});
