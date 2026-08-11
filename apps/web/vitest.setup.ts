import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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

// Vitest is configured without globals, so Testing Library cannot auto-register
// its own cleanup. Without this, rendered trees leak between tests and
// `getByRole` starts finding duplicates.
afterEach(() => {
  cleanup();
});
