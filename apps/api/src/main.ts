// Must stay the first import: the error tracker instruments modules as they load,
// so anything imported before it is invisible to it.
import './instrument';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import type { Env } from './config/env.schema';

async function bootstrap(): Promise<void> {
  // Buffered until `configureApp` installs the real logger, so boot-time output is
  // structured too rather than arriving as Nest's default console format.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  configureApp(app);

  const port = app.get<ConfigService<Env, true>>(ConfigService).get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  Logger.log(`API listening on http://0.0.0.0:${port}/api`, 'Bootstrap');
}

void bootstrap();
