const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

/**
 * Loads the repository-root `.env` — the same file `ConfigModule`,
 * `prisma.config.mjs` and Docker Compose read — before Jest builds its test
 * environments.
 *
 * It has to happen here rather than in the spec: Jest's `node` environment
 * hands each test file a copy of `process.env` made when that environment is
 * created, so a `loadEnvFile` inside a test writes to the real process and the
 * test never sees it. `globalSetup` runs first, in the parent process, and the
 * copies are taken from the result.
 *
 * A real environment always wins — `loadEnvFile` leaves variables that are
 * already set alone — so `APP_DATABASE_URL=… pnpm test:db` and CI both override
 * the file rather than fight it.
 */
module.exports = function loadRepositoryEnv() {
  const file = resolve(__dirname, '../../.env');

  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
};
