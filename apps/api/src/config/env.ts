import { envSchema, type Env } from './env.schema';

/**
 * Drops keys whose value is blank, so `KEY=` in a `.env` file means "not set"
 * rather than "set to an empty string".
 *
 * That is what everyone reading a `.env` file assumes, and the alternative bites
 * immediately: `.env.example` documents optional keys as `KEY=`, the README tells
 * you to copy it, and without this an empty `SENTRY_DSN=` fails URL validation and
 * the API refuses to boot on a fresh clone.
 *
 * It does not weaken the required-in-production check. A blank `DATABASE_URL`
 * becomes absent, which the schema then rejects with "is required when
 * NODE_ENV=production" — a better message than "expected string to have >=1
 * characters", and the same refusal to boot.
 */
function withoutBlanks(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => !(typeof value === 'string' && value.trim() === '')),
  );
}

/**
 * Passed to `ConfigModule.forRoot({ validate })`, so an invalid environment
 * fails the boot rather than the first request that happens to need the key.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(withoutBlanks(raw));

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
