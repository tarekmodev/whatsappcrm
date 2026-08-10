import { VersioningType, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Shared by `main.ts` and the end-to-end tests, so the tested application is
 * configured identically to the deployed one.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);

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
    origin: config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000',
    credentials: true,
  });
}
