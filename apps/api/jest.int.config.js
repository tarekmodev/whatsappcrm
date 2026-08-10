/**
 * Integration tests: `*.int-spec.ts`, run against a real PostgreSQL.
 *
 * Kept out of `jest.config.js` on purpose. `pnpm test` must stay runnable with
 * no containers up, and a suite that skips itself when the database is absent
 * is worse than one that is not run — a skipped isolation test reads as a green
 * tick. These fail loudly instead, and CI runs them in the Database job where
 * the stack exists (`.github/workflows/ci.yml`).
 *
 * `--runInBand` in the `test:db` script: the suites share one database and
 * commit their fixtures, so running them in parallel would have them delete
 * each other's rows.
 *
 * Run it through Turbo (`pnpm test:db`), never `jest` directly:
 * `@whatsappcrm/contracts` is consumed from its `dist`, and the `test:db` task
 * in `turbo.json` is what declares the `^build` that produces it. Invoked
 * without that, a clean checkout fails every suite here with "Cannot find
 * module '@whatsappcrm/contracts'" — which looks like a database problem and is
 * not one.
 */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'src',
  testEnvironment: 'node',
  globalSetup: '<rootDir>/../jest.int.setup.cjs',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.int-spec\\.ts$',
  // A leaked connection pool keeps the process alive; fail rather than hang CI.
  testTimeout: 30_000,
  forceExit: false,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
};
