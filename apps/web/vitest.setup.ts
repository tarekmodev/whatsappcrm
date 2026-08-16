import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Testing Library's async helpers default to one second, which is a fine budget
 * for a state update and a poor one for the thing several of these tests are
 * actually waiting on: a `next/dynamic` boundary resolving its chunk, which in
 * Vitest means transforming and evaluating that module graph for the first time.
 *
 * On an unloaded machine it lands in a few hundred milliseconds; with the whole
 * suite running in parallel it does not, and the failure is a timeout on
 * `findByRole('dialog')` that says nothing about the component under test. Five
 * seconds is still short enough that a genuinely stuck assertion fails fast.
 */
configure({ asyncUtilTimeout: 5_000 });

/**
 * jsdom ships `<dialog>` but not `showModal`/`close`, so any test that renders a
 * `Modal` — directly, or through a component that opens one — dies in an effect
 * with `showModal is not a function`.
 *
 * Stubbed here rather than per file: it is a gap in the environment, not
 * something an individual case should have to know about. Deliberately only
 * `open`; the focus behaviour of a real modal dialog is not reproduced, and
 * `Modal.test.tsx` covers the parts the component owns itself.
 */
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.open = true;
};

HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.open = false;
};

/**
 * jsdom has no layout, so it ships no `scrollIntoView` at all — a component that
 * keeps a highlighted row in view dies in an effect rather than failing an
 * assertion. A no-op for the same reason as `showModal` above: the environment is
 * missing the method, and there is no scroll position here to be right about.
 */
Element.prototype.scrollIntoView = function scrollIntoView() {
  // Intentionally empty: jsdom does not lay out, so there is nothing to scroll.
};

/**
 * And no `ResizeObserver`, for the same reason — any component that measures
 * itself (`useToastClearance`, and whatever follows it) dies in an effect with
 * `ResizeObserver is not defined`.
 *
 * A no-op rather than a fake: without layout every box jsdom reports is zero, so
 * there is nothing for an observation to report. What the stub buys is that a
 * component measuring itself still *renders*, which is what those tests are
 * about; the measurement is verified in the browser.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// Vitest is configured without globals, so Testing Library cannot auto-register
// its own cleanup. Without this, rendered trees leak between tests and
// `getByRole` starts finding duplicates.
afterEach(() => {
  cleanup();
});
