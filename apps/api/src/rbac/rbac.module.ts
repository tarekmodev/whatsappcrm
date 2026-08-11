import { Global, Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_STUB_ON } from '../config/env.schema';
import { SessionPrincipalSource } from '../identity/session-principal.source';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { PermissionGuard } from './permission.guard';
import { PrincipalGuard } from './principal.guard';
import { PRINCIPAL_SOURCE, type PrincipalSource } from './principal.source';
import { SessionRevocationService } from './session-revocation.service';
import { StubPrincipalSource } from './stub-principal.source';

/**
 * Roles, permissions and the guards that enforce them (TAR-39, module map:
 * `RbacModule`).
 *
 * Global, for the same reason `PrismaModule` is: a feature module that had to
 * remember to import the guards is a feature module that will one day ship a
 * route without them. Importing it is not what protects a controller — declaring
 * the guards is — but the providers being reachable from anywhere removes one
 * way to get that wrong.
 *
 * ## The one binding
 *
 * `PRINCIPAL_SOURCE` is the seam, and TAR-56 filled it: the default is now
 * `SessionPrincipalSource`, which reads the session cookie against the tenant
 * the request host resolved. Nothing downstream of `PrincipalGuard` knows or
 * cares which implementation is bound — the guards, the permission matrix and
 * the visibility predicate run identically either way, which is exactly what
 * TAR-22 stubbed *the source* rather than the guard to achieve.
 *
 * `AUTH_STUB_ENABLED=true` still swaps in the interim stub, and still refuses
 * to boot under `NODE_ENV=production`. It survives because TAR-82's console
 * drives it from the same switch; removing both halves is TAR-62's, once the
 * console signs in for real.
 */
const principalSourceProvider: Provider = {
  provide: PRINCIPAL_SOURCE,
  inject: [ConfigService, TENANT_PRISMA, SessionPrincipalSource],
  useFactory: (
    config: ConfigService,
    prisma: TenantPrisma,
    sessions: SessionPrincipalSource,
  ): PrincipalSource => {
    const logger = new Logger(RbacModule.name);

    if (config.get<string>('AUTH_STUB_ENABLED') === AUTH_STUB_ON) {
      // Loud on purpose. Which source is bound decides who every request is
      // attributed to, and an operator reading a startup log should never have
      // to infer it from a 401.
      logger.warn(
        'Callers are being resolved by the INTERIM ROLE STUB (AUTH_STUB_ENABLED=true), ' +
          'not by their session cookie. Development and tests only.',
      );
      return new StubPrincipalSource(prisma);
    }

    return sessions;
  },
};

@Global()
@Module({
  providers: [principalSourceProvider, PrincipalGuard, PermissionGuard, SessionRevocationService],
  exports: [PRINCIPAL_SOURCE, PrincipalGuard, PermissionGuard, SessionRevocationService],
})
export class RbacModule {}
