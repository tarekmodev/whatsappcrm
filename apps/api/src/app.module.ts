import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware } from './common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from './common/tenant-context/tenant-context.module';
import { validateEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './infra/database/database.module';
import { RedisModule } from './infra/redis/redis.module';
import { ObservabilityModule } from './observability/observability.module';
import { RequestLoggingMiddleware } from './observability/request-logging.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    TenantContextModule,
    ObservabilityModule,
    DatabaseModule,
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
