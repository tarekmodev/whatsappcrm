import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One `.env` for the whole repository, at the root — the same file
 * `prisma.config.mjs` and Docker Compose read. Resolved from `__dirname` rather
 * than the process working directory, which is `apps/api` under `pnpm dev`, the
 * repository root under `pnpm test` and `/app` in a container.
 *
 * This module compiles to `dist/`, so the three levels are `dist` → `apps/api` →
 * `apps` → the repository root. Anything importing it inherits that answer, so
 * moving this file means changing the path with it.
 */
export const REPOSITORY_ENV_FILE = resolve(__dirname, '../../../.env');

/**
 * Loads that file into `process.env` for readers that run before Nest exists —
 * today only `instrument.ts`, which has to start the error tracker before the
 * modules it instruments are imported, and therefore before `ConfigModule`.
 *
 * A real environment always wins: `process.loadEnvFile` leaves an already-set
 * variable alone, exactly as `ConfigModule` does, so a deployed process reads its
 * platform's secrets and this file is simply absent.
 *
 * Skipped under `NODE_ENV=test` for the same reason `ConfigModule` sets
 * `ignoreEnvFile` there: the suite must never read a developer's `.env`.
 */
export function loadRepositoryEnvFile(): void {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  if (!existsSync(REPOSITORY_ENV_FILE)) {
    return;
  }

  process.loadEnvFile(REPOSITORY_ENV_FILE);
}
