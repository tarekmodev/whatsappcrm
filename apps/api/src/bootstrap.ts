import { VersioningType, type INestApplication, type Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { KNOWLEDGE_DOCUMENT_LIMITS } from '@whatsappcrm/contracts';
import type { Env } from './config/env.schema';
import { AppLoggerService } from './observability/app-logger.service';

/**
 * The largest JSON body the API will read.
 *
 * Express defaults to 100 KB, which is below a cap this platform publishes: a
 * knowledge document may be 256 KiB, so an admin pasting a long policy document
 * had the request refused by the parser before any handler saw it — and a limit
 * nothing can reach is worse than no limit, because the number is written down.
 *
 * Derived from that cap rather than written beside it, so the two cannot drift.
 * Doubled because the cap governs one field and a body carries more: the title,
 * the source URL, the language, and JSON escaping, which can inflate a document
 * well past its own byte count. The remaining headroom is small enough that the
 * limit is still doing its job — the point of it is to refuse a body no honest
 * client sends.
 */
const JSON_BODY_LIMIT_BYTES = KNOWLEDGE_DOCUMENT_LIMITS.contentBytes * 2;

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

  // Re-registers the JSON parser at the platform's limit rather than Express's
  // 100 KB default. `useBodyParser` rather than `app.use(json({...}))` because
  // Nest's own registration is what preserves `rawBody`, and the WhatsApp
  // webhook verifies Meta's signature over those exact bytes — replacing the
  // parser by hand would break the webhook in a way that reads as a wrong app
  // secret.
  //
  // Guarded rather than cast: every application here is Express, and the day one
  // is not, losing a body limit silently is not the failure to accept.
  if (hasBodyParser(app)) {
    app.useBodyParser('json', { limit: JSON_BODY_LIMIT_BYTES });
  } else {
    logger?.warn(
      `Body parser limit not applied: the adapter has no useBodyParser, so JSON bodies are ` +
        `capped at the platform default and a ${KNOWLEDGE_DOCUMENT_LIMITS.contentBytes}-byte ` +
        `knowledge document will be refused.`,
      'Bootstrap',
    );
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

/**
 * Every application in this repo is Express, but `configureApp` takes the
 * platform-neutral interface — 25 controller specs pass an `INestApplication`
 * and widening the parameter would edit all of them to configure a body limit.
 */
function hasBodyParser(app: INestApplication): app is INestApplication & NestExpressApplication {
  return typeof (app as Partial<NestExpressApplication>).useBodyParser === 'function';
}

/** `app.get` throws when a provider is not in the module graph; this asks instead. */
function tryGet<T>(app: INestApplication, token: Type<T>): T | null {
  try {
    return app.get(token);
  } catch {
    return null;
  }
}
