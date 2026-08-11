// Must stay the first import: the error tracker instruments modules as they load,
// so anything imported before it is invisible to it.
import './instrument';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import type { Env } from './config/env.schema';
import { RealtimeIoAdapter } from './realtime/realtime-io.adapter';

async function bootstrap(): Promise<void> {
  // `rawBody` keeps the exact bytes of each request alongside the parsed body.
  // Meta signs the raw payload, and a body that was parsed and re-serialised
  // does not reproduce it — so without this the WhatsApp webhook rejects every
  // genuine delivery, and the failure reads as a wrong app secret rather than as
  // a missing option (TAR-39, signature check). `apps/api/src/webhooks` is the
  // only reader; the cost is one retained buffer per request.
  //
  // `bufferLogs` holds boot output until `configureApp` installs the real logger,
  // so it is structured too rather than arriving in Nest's default console format.
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });

  configureApp(app);

  // Installed here rather than in `configureApp` because it opens Redis
  // connections: every HTTP spec calls `configureApp` so the tested app is
  // configured like the deployed one, and none of them should acquire a pub/sub
  // pair to exercise a controller. The gateway's own specs install it themselves.
  app.useWebSocketAdapter(await RealtimeIoAdapter.create(app));

  const port = app.get<ConfigService<Env, true>>(ConfigService).get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  Logger.log(`API listening on http://0.0.0.0:${port}/api`, 'Bootstrap');
}

void bootstrap();
