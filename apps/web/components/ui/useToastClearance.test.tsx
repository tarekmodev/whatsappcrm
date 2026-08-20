import { describe, expect, it } from 'vitest';
import { useRef } from 'react';
import { render } from '@testing-library/react';
import { useToastClearance } from './useToastClearance';

/**
 * The hook publishes one custom property on the document element, and the two
 * things worth pinning are the arithmetic and the cleanup — a route that stops
 * pinning a control must hand the toast region its full corner back.
 *
 * jsdom lays nothing out, so `getBoundingClientRect` is stubbed per case: the
 * measurement is verified in a browser, the *contract* is verified here.
 */

const PROPERTY = '--offset-toast-block-end';

function Dock({ top }: { top: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useToastClearance(ref);

  return (
    <div
      ref={(node) => {
        if (node !== null) {
          node.getBoundingClientRect = () => ({ top }) as DOMRect;
        }

        ref.current = node;
      }}
    />
  );
}

describe('useToastClearance', () => {
  it('clears the distance from the viewport bottom to the control, not its height', () => {
    window.innerHeight = 800;

    render(<Dock top={620} />);

    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe('180px');
  });

  it('floors at zero rather than publishing a negative offset', () => {
    window.innerHeight = 800;

    // A control scrolled below the fold: `innerHeight - top` goes negative, and a
    // negative inset would pull the toast region off the bottom of the screen.
    render(<Dock top={900} />);

    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe('0px');
  });

  it('gives the corner back on unmount, so the next route is back to the default', () => {
    window.innerHeight = 800;

    const { unmount } = render(<Dock top={620} />);

    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe('180px');

    unmount();

    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe('');
  });
});
