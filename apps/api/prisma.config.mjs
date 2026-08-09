// Prisma CLI configuration.
//
// Prisma 7 removed both the implicit `.env` load and `url = env(...)` inside the
// schema's datasource block, so this file is what connects the CLI to the local
// database. It is `.mjs` rather than `.ts` on purpose: a `.ts` file here would
// sit outside every `tsconfig`, which the type-aware ESLint rules reject
// (see the CI section of README.md).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, env } from 'prisma/config';

const here = path.dirname(fileURLToPath(import.meta.url));

// One `.env` for the whole repository, at the root — the same file the apps
// read. `loadEnvFile` leaves already-set variables alone, so a real environment
// (CI, or `DATABASE_URL=... pnpm db:migrate:deploy`) always wins over the file.
const rootEnv = path.resolve(here, '../../.env');
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  schema: path.join(here, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(here, 'prisma', 'migrations'),
  },
  datasource: {
    // Throws with a named-variable error if unset, which is the right failure:
    // a migration against an accidental default database is much worse than a
    // command that refuses to run.
    url: env('DATABASE_URL'),

    // Local-only, and optional: `migrate dev` creates and drops its own shadow
    // database, but `migrate diff --to-migrations` — how down migrations are
    // generated — needs a named one. Left undefined in deployed environments,
    // where only `migrate deploy` runs and no shadow database is used.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
