import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantContextMiddleware } from './common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from './common/tenant-context/tenant-context.module';
import { validateEnv } from './config/env';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    TenantContextModule,
    HealthModule,
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
