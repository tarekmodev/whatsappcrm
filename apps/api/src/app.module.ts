import { resolve } from 'node:path';
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TenantContextMiddleware } from './common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from './common/tenant-context/tenant-context.module';
import { validateEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

/**
 * One `.env` for the whole repository, at the root — the same file
 * `prisma.config.mjs` and Docker Compose read. Without this, `ConfigModule`
 * looks in the process working directory, which is `apps/api` under `pnpm dev`,
 * the repository root under `pnpm test`, and `/app` in a container. A real
 * environment always wins: `ConfigModule` never overwrites a variable that is
 * already set, so a deployed process reads its platform's secrets and this file
 * is simply absent.
 */
const REPOSITORY_ENV_FILE = resolve(__dirname, '../../../.env');

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: [REPOSITORY_ENV_FILE],
    }),
    // The in-process bus TAR-39 chose for same-request fan-out where loss is
    // acceptable — the realtime relay is its first consumer. Anything that must
    // survive a restart goes on BullMQ instead, through `QueueModule`.
    EventEmitterModule.forRoot(),
    TenantContextModule,
    PrismaModule,
    QueueModule,
    HealthModule,
    TenancyModule,
    WhatsAppModule,
    WebhooksModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including the ones later stories add — a route that escapes
    // the tenant context scope is a route with no tenant isolation.
    // `{*path}` is the path-to-regexp v8 spelling of the old `*` wildcard.
    consumer.apply(TenantContextMiddleware).forRoutes('{*path}');
  }
}
