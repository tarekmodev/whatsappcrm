import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirrors `tsconfig.json`: `@/*` is `apps/web`, whose `components/ui` this
      // app consumes wholesale, and `~/*` is this app's own code.
      '@': fileURLToPath(new URL('../web/', import.meta.url)),
      '~': fileURLToPath(new URL('.', import.meta.url)),
      // `server-only` is a build-time guard Next resolves from its own bundled
      // copy; point it at the empty stub so a server module can be unit-tested.
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
