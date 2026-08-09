import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  configureApp(app);

  const port = app.get(ConfigService).get<number>('PORT') ?? 3001;
  await app.listen(port, '0.0.0.0');

  Logger.log(`API listening on http://0.0.0.0:${port}/api`, 'Bootstrap');
}

void bootstrap();
