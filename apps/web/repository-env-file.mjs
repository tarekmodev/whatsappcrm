// One `.env` for the whole repository, at the root — the same file `apps/api`,
// `apps/api/prisma.config.mjs` and Docker Compose read.
//
// It is `.mjs` rather than `.ts` for the reason `prisma.config.mjs` records: the
// only importer is `next.config.mjs`, which Next loads as plain JavaScript long
// before anything is compiled.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolved from this file's own location rather than the process working
 * directory, which is `apps/web` under `pnpm dev` and the repository root when
 * Turborepo runs the build. Two levels: `apps/web` → `apps` → the repository
 * root, so moving this file means changing the path with it.
 *
 * @type {string}
 */
export const REPOSITORY_ENV_FILE = path.resolve(here, '../../.env');

/**
 * Loads that file into `process.env` for `next.config.mjs`.
 *
 * Next only auto-loads `.env` files sitting beside the app it serves, so a
 * documented `cp .env.example .env` at the repository root left this process
 * with no `TRUSTED_PROXY_SECRET` and every browser call through the `/api/*`
 * rewrite answered `tenant_not_found` (TAR-164).
 *
 * A real environment always wins: `process.loadEnvFile` leaves an already-set
 * variable alone, so Render — which sets each service's variables directly — and
 * anything Next already loaded from `apps/web/.env*` both take precedence, and
 * this file is simply absent there.
 *
 * @param {string} [file] The env file to load. Defaults to the repository root's.
 * @returns {void}
 */
export function loadRepositoryEnvFile(file = REPOSITORY_ENV_FILE) {
  if (!existsSync(file)) {
    return;
  }

  process.loadEnvFile(file);
}
