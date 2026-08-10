import { Global, Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_STUB_ON } from '../config/env.schema';
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
 * ## The one binding that changes when TAR-35 lands
 *
 * `PRINCIPAL_SOURCE` is the seam. Today it can only be `StubPrincipalSource`,
 * and only when `AUTH_STUB_ENABLED=true`; TAR-35 adds `SessionPrincipalSource`
 * and binds it here. Nothing downstream of `PrincipalGuard` knows or cares which
 * is bound, so the swap is this factory plus deleting the stub file.
 */
const principalSourceProvider: Provider = {
  provide: PRINCIPAL_SOURCE,
  inject: [ConfigService, TENANT_PRISMA],
  useFactory: (config: ConfigService, prisma: TenantPrisma): PrincipalSource => {
    const logger = new Logger(RbacModule.name);
    const configured = config.get<string>('AUTH_STUB_ENABLED');

    if (configured === AUTH_STUB_ON) {
      // Loud on purpose. Which source is bound decides who every request is
      // attributed to, and an operator reading a startup log should never have
      // to infer it from a 401.
      logger.warn(
        'Callers are being resolved by the INTERIM ROLE STUB (AUTH_STUB_ENABLED=true). ' +
          'Development and tests only — remove when TAR-35 lands.',
      );
      return new StubPrincipalSource(prisma);
    }

    logger.log(
      `No principal source is bound (AUTH_STUB_ENABLED=${configured ?? 'unset'}); ` +
        'every authenticated route answers 401 until TAR-35 provides sessions.',
    );

    // No session source exists yet, so the honest binding is one that
    // authenticates nobody. Every route behind `PrincipalGuard` answers 401
    // until TAR-35 lands or the stub is switched on deliberately — which is the
    // correct failure for an environment with no way to sign in, and is very
    // different from a source that fabricates a caller.
    return {
      resolve: () => Promise.resolve(null),
    };
  },
};

@Global()
@Module({
  providers: [principalSourceProvider, PrincipalGuard, PermissionGuard, SessionRevocationService],
  exports: [PRINCIPAL_SOURCE, PrincipalGuard, PermissionGuard, SessionRevocationService],
})
export class RbacModule {}
