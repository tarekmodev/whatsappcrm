import { resolve } from 'node:path';
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware } from './common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from './common/tenant-context/tenant-context.module';
import { validateEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { RedisModule } from './infra/redis/redis.module';
import { ObservabilityModule } from './observability/observability.module';
import { RequestLoggingMiddleware } from './observability/request-logging.middleware';
import { PrismaModule } from './prisma/prisma.module';

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
    TenantContextModule,
    ObservabilityModule,
    PrismaModule,
    RedisModule,
    HealthModule,
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
