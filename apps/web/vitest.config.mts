import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirrors the `@/*` path alias in tsconfig.json. Without it, every module
      // under test that uses the alias fails to resolve.
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // `server-only` is a build-time guard that Next resolves from its own
      // bundled copy; there is no standalone package to install. Point it at
      // Next's empty stub so a server module can be unit-tested directly.
      'server-only': 'next/dist/compiled/server-only/empty',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
  },
});
