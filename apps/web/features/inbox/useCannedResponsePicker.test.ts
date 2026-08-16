import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import type { CannedResponseResponse } from '@whatsappcrm/contracts';
import { useCannedResponsePicker } from '@/features/inbox/useCannedResponsePicker';

/**
 * The picker's state machine, driven directly.
 *
 * `ReplyDraftField.test.tsx` covers what an agent does; this covers the one
 * thing a rendered test cannot reach. React reports a selection alongside the
 * very keystroke that moved the highlight, so `sync` is called again with input
 * it has already seen — and re-opening on identical input silently put the
 * highlight back on the first row. jsdom's event plugins do not reproduce that
 * pairing, so the invariant is pinned here: **`sync` with an unchanged token and
 * caret must change nothing.**
 */

function response(shortcut: string, title: string): CannedResponseResponse {
  return {
    id: `id${shortcut}`,
    shortcut,
    title,
    body: `Body of ${shortcut}`,
    createdByUserId: null,
    createdAt: '2026-08-11T08:00:00.000Z',
    updatedAt: '2026-08-11T08:00:00.000Z',
  };
}

const LIBRARY: readonly CannedResponseResponse[] = [
  response('/holiday', 'Public holiday closure'),
  response('/hours', 'Opening hours'),
];

function renderPicker(draft = '') {
  let current = draft;
  const textareaRef = createRef<HTMLTextAreaElement>();

  const view = renderHook(
    ({ value }: { value: string }) =>
      useCannedResponsePicker({
        responses: LIBRARY,
        draft: value,
        onDraftChange: (next) => {
          current = next;
        },
        textareaRef,
      }),
    { initialProps: { value: draft } },
  );

  return {
    picker: () => view.result.current,
    draft: () => current,
    sync: (value: string) => {
      act(() => {
        view.result.current.sync(value, value.length, value.length);
      });
    },
    press: (key: string) => {
      act(() => {
        view.result.current.handleKeyDown(key);
      });
    },
  };
}

describe('re-syncing unchanged input', () => {
  it('leaves the highlight where the arrow keys put it', () => {
    const view = renderPicker();

    view.sync('/ho');
    expect(view.picker().activeIndex).toBe(0);

    view.press('ArrowDown');
    expect(view.picker().activeIndex).toBe(1);

    // The selection React reports alongside that same keystroke.
    view.sync('/ho');

    expect(view.picker().activeIndex).toBe(1);
    expect(view.picker().activeOptionId).toContain('-1');
  });

  it('so Enter still commits the row the agent is looking at', () => {
    const view = renderPicker();

    view.sync('/ho');
    view.press('ArrowDown');
    view.sync('/ho');
    view.press('Enter');

    expect(view.draft()).toBe('Body of /hours');
  });

  it('resets the highlight when the token actually changes', () => {
    const view = renderPicker();

    view.sync('/ho');
    view.press('ArrowDown');
    view.sync('/hol');

    expect(view.picker().activeIndex).toBe(0);
  });
});
