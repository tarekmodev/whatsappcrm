import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The integration suite, kept apart from `vitest.config.mts` rather than merged
 * into it. `*.int-test.ts` runs a real `next build` and a real `next start`, so
 * it is minutes rather than seconds and it overwrites `.next` — neither belongs
 * in the suite a developer runs on save.
 *
 * No jsdom and no React plugin: nothing here renders. The request is made over a
 * socket, which is the entire point.
 */
export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json, as the unit config does.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['**/*.int-test.ts'],
    exclude: ['node_modules/**', '.next/**'],
    // One build, one pair of ports, one `.next`. Files running in parallel would
    // contend for all three.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
