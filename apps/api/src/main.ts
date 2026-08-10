import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  // `rawBody` keeps the exact bytes of each request alongside the parsed body.
  // Meta signs the raw payload, and a body that was parsed and re-serialised
  // does not reproduce it — so without this the WhatsApp webhook rejects every
  // genuine delivery, and the failure reads as a wrong app secret rather than as
  // a missing option (TAR-39, signature check). `apps/api/src/webhooks` is the
  // only reader; the cost is one retained buffer per request.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  configureApp(app);

  const port = app.get(ConfigService).get<number>('PORT') ?? 3001;
  await app.listen(port, '0.0.0.0');

  Logger.log(`API listening on http://0.0.0.0:${port}/api`, 'Bootstrap');
}

void bootstrap();
