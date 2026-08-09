import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest is configured without globals, so Testing Library cannot auto-register
// its own cleanup. Without this, rendered trees leak between tests and
// `getByRole` starts finding duplicates.
afterEach(() => {
  cleanup();
});
