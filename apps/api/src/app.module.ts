import { resolve } from 'node:path';
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuditModule } from './audit/audit.module';
import { TenantContextMiddleware } from './common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from './common/tenant-context/tenant-context.module';
import { validateEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { MediaModule } from './media/media.module';
import { ObservabilityModule } from './observability/observability.module';
import { RequestLoggingMiddleware } from './observability/request-logging.middleware';
import { PeopleModule } from './people/people.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RbacModule } from './rbac/rbac.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { TicketsModule } from './tickets/tickets.module';
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
      // The suite must never read a developer's `.env`. A test whose result
      // depends on whether someone happens to have Postgres running locally is
      // not a test, and the readiness specs assert the unconfigured case.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    // The in-process bus TAR-39 chose for same-request fan-out where loss is
    // acceptable — the realtime relay is its first consumer. Anything that must
    // survive a restart goes on BullMQ instead, through `QueueModule`.
    EventEmitterModule.forRoot(),
    TenantContextModule,
    ObservabilityModule,
    PrismaModule,
    QueueModule,
    AuditModule,
    RbacModule,
    HealthModule,
    TenancyModule,
    PeopleModule,
    WhatsAppModule,
    TicketsModule,
    MediaModule,
    WebhooksModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including the ones later stories add — a route that escapes
    // the tenant context scope is a route with no tenant isolation.
    // `{*path}` is the path-to-regexp v8 spelling of the old `*` wildcard.
    //
    // Order matters: request logging must run *inside* the context scope the
    // tenant middleware opens, or every request line loses its `requestId` and
    // `tenantId`.
    consumer.apply(TenantContextMiddleware, RequestLoggingMiddleware).forRoutes('{*path}');
  }
}
