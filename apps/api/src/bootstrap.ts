import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Shared by `main.ts` and the end-to-end tests, so the tested application is
 * configured identically to the deployed one.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  app.enableCors({
    origin: config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000',
    credentials: true,
  });
}
