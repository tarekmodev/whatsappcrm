import { Global, Inject, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { createPrismaClient } from './prisma-client.factory';
import {
  SYSTEM_PRISMA,
  TENANT_PRISMA,
  type SystemPrisma,
  type TenantPrisma,
} from './prisma.tokens';
import { withTenantScope } from './tenant-scope.extension';

const tenantPrismaProvider: Provider = {
  provide: TENANT_PRISMA,
  inject: [ConfigService, TenantContextService],
  useFactory: (config: ConfigService, tenantContext: TenantContextService): TenantPrisma =>
    withTenantScope(
      createPrismaClient('tenant', config.getOrThrow<string>('APP_DATABASE_URL')),
      tenantContext,
    ),
};

const systemPrismaProvider: Provider = {
  provide: SYSTEM_PRISMA,
  inject: [ConfigService],
  useFactory: (config: ConfigService): SystemPrisma =>
    createPrismaClient('system', config.getOrThrow<string>('SYSTEM_DATABASE_URL')),
};

/**
 * Owns both database clients and their connection pools (TAR-39, module map).
 *
 * Global, because a feature module that had to remember to import it is a
 * feature module that will one day construct its own client with the wrong
 * connection string. There is exactly one `TenantPrisma` and one
 * `SystemPrisma` per process, and this is where they come from.
 *
 * Both are singletons rather than request-scoped: request scope would rebuild
 * the whole provider subtree per request and still would not exist for queue
 * workers or WebSocket handlers. The tenant travels through
 * `TenantContextService`'s `AsyncLocalStorage` instead, which all three entry
 * points share.
 */
@Global()
@Module({
  providers: [tenantPrismaProvider, systemPrismaProvider],
  exports: [TENANT_PRISMA, SYSTEM_PRISMA],
})
export class PrismaModule implements OnApplicationShutdown {
  constructor(
    @Inject(TENANT_PRISMA) private readonly tenantPrisma: TenantPrisma,
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
  ) {}

  /**
   * Returns both pools to Postgres on `SIGTERM` (`app.enableShutdownHooks()` in
   * `bootstrap.ts` is what delivers it). Without this a rolling deploy leaves
   * connections held until the server times them out, and a fleet of restarting
   * pods can exhaust `max_connections` on the way up.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.tenantPrisma.$disconnect(), this.systemPrisma.$disconnect()]);
  }
}
