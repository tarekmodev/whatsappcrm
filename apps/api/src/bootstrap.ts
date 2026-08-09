import type { INestApplication } from '@nestjs/common';
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
  app.useLogger(app.get(AppLoggerService));

  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  app.enableCors({
    origin: config.get('WEB_ORIGIN', { infer: true }),
    credentials: true,
  });
}
