import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useStickToBottom } from './useStickToBottom';

/**
 * The rule that makes a live thread bearable: follow the newest message only if
 * the reader was already at the bottom, and — TAR-518 — say how much they missed
 * if they were not, instead of silently leaving them behind.
 *
 * jsdom reports every scroll dimension as `0`, which would make the hook believe
 * the reader is permanently at the bottom, so the harness below gives the
 * scroller a geometry. That is the whole point of the test: the interesting
 * branch is the one that only happens when the box actually overflows.
 */

const VIEWPORT = 400;
const CONTENT = 1200;

function Harness({ newestId, count }: { newestId: string; count: number }) {
  const { scrollerRef, missedCount, jumpToLatest } = useStickToBottom(newestId, count);

  return (
    <>
      <div ref={scrollerRef} data-testid="scroller" />
      <output data-testid="missed">{missedCount}</output>
      <button type="button" onClick={jumpToLatest}>
        jump
      </button>
    </>
  );
}

function scroller(): HTMLElement {
  return screen.getByTestId('scroller');
}

/** Gives the box a size, so "at the bottom" is a question with two answers. */
function giveGeometry(): void {
  Object.defineProperty(scroller(), 'scrollHeight', { value: CONTENT, configurable: true });
  Object.defineProperty(scroller(), 'clientHeight', { value: VIEWPORT, configurable: true });
}

function scrollTo(top: number): void {
  scroller().scrollTop = top;
  fireEvent.scroll(scroller());
}

function missed(): string {
  return screen.getByTestId('missed').textContent ?? '';
}

describe('useStickToBottom', () => {
  it('follows a new message while the reader is at the bottom, which is where a thread opens', () => {
    // The hook starts pinned — a thread opens on its newest message, not on the
    // top of a two-year-old conversation — and this is that state carrying on.
    const view = render(<Harness newestId="a" count={1} />);
    giveGeometry();
    scrollTo(CONTENT - VIEWPORT);

    view.rerender(<Harness newestId="b" count={2} />);

    expect(scroller().scrollTop).toBe(CONTENT);
    expect(missed()).toBe('0');
  });

  it('does not yank a reader who has scrolled up, and counts what they missed', () => {
    const view = render(<Harness newestId="a" count={1} />);
    giveGeometry();
    scrollTo(0);

    view.rerender(<Harness newestId="b" count={2} />);
    view.rerender(<Harness newestId="c" count={4} />);

    expect(scroller().scrollTop).toBe(0);
    // Two arrived in the second rerender, so the count is the total, not the
    // number of times the thread changed.
    expect(missed()).toBe('3');
  });

  it('clears the count when the reader scrolls back down themselves', () => {
    const view = render(<Harness newestId="a" count={1} />);
    giveGeometry();
    scrollTo(0);
    view.rerender(<Harness newestId="b" count={2} />);
    expect(missed()).toBe('1');

    scrollTo(CONTENT - VIEWPORT);

    expect(missed()).toBe('0');
  });

  it('jumps to the newest message and clears the count on request', () => {
    const view = render(<Harness newestId="a" count={1} />);
    giveGeometry();
    scrollTo(0);
    view.rerender(<Harness newestId="b" count={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'jump' }));

    expect(scroller().scrollTop).toBe(CONTENT);
    expect(missed()).toBe('0');
  });
});
