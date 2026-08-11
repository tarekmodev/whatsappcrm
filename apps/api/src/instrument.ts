import * as Sentry from '@sentry/nestjs';
import { loadRepositoryEnvFile } from './repository-env-file';

/**
 * Sentry has to be initialised before the modules it instruments are imported,
 * which is why this is the very first import in `main.ts` and reads `process.env`
 * directly instead of waiting for the validated config. It is the one place in the
 * codebase allowed to do that.
 *
 * That ordering is also why it loads the repository `.env` itself: `ConfigModule`
 * only reads the file once `AppModule` is constructed, which is after this runs,
 * so a `SENTRY_DSN` set there would otherwise be silently ignored and local
 * development could never point at a tracker at all. A real environment is
 * unaffected — neither loader overwrites a variable that is already set.
 *
 * With no DSN the SDK is simply not started: `captureException` becomes a no-op,
 * so local development and the test suite carry no tracker at all rather than a
 * disabled one that still installs global handlers.
 */
export function initErrorTracking(): void {
  loadRepositoryEnvFile();

  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.DEPLOY_ENV ?? 'local',
    release: process.env.APP_VERSION,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // Never let the SDK decide what personal data is safe to attach. WhatsApp
    // conversation content is personal data, and an error tracker is not a lawful
    // place to keep it.
    sendDefaultPii: false,
  });
}

initErrorTracking();
