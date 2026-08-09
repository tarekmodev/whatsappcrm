import { envSchema, type Env } from './env.schema';

/**
 * Passed to `ConfigModule.forRoot({ validate })`, so an invalid environment
 * fails the boot rather than the first request that happens to need the key.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
