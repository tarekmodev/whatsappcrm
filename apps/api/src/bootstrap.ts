import { VersioningType, type INestApplication, type Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './config/env.schema';
import { AppLoggerService } from './observability/app-logger.service';

/**
 * Shared by `main.ts` and the end-to-end tests, so the tested application is
 * configured identically to the deployed one.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Replaces Nest's own logger, so framework output lands in the same structured
  // stream — and carries the same tenant fields — as everything we write.
  //
  // Optional on purpose. Controller specs assemble a narrow testing module with
  // just the pieces under test and still call this function, precisely so the
  // tested app is configured like the deployed one. Requiring a provider only
  // `ObservabilityModule` supplies would make every such spec import logging to
  // test something unrelated, and the fallback — Nest's own logger — is exactly
  // what those specs had before.
  const logger = tryGet(app, AppLoggerService);

  if (logger) {
    app.useLogger(logger);
  }

  app.setGlobalPrefix('api');
  // `/api/v1/...` (TAR-39, conventions). URI versioning rather than an `Accept`
  // header: the version is then visible in an access log and in a CDN rule.
  //
  // There is no `defaultVersion`. A controller states its version explicitly or
  // marks itself `VERSION_NEUTRAL`, so adding v2 later is a decision taken per
  // controller instead of a default that silently moved every route.
  app.enableVersioning({ type: VersioningType.URI });
  app.enableShutdownHooks();
  app.enableCors({
    origin: config.get('WEB_ORIGIN', { infer: true }),
    credentials: true,
  });
}

/** `app.get` throws when a provider is not in the module graph; this asks instead. */
function tryGet<T>(app: INestApplication, token: Type<T>): T | null {
  try {
    return app.get(token);
  } catch {
    return null;
  }
}
