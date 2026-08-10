import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { PrismaModule } from './prisma.module';
import {
  SYSTEM_PRISMA,
  TENANT_PRISMA,
  type SystemPrisma,
  type TenantPrisma,
} from './prisma.tokens';

/**
 * The split itself: two clients, two connection strings, two database roles.
 *
 * The property worth protecting here is that `SystemPrisma` is a **separate
 * export** rather than a flag on `TenantPrisma`. A flag would be one typo away
 * from being set, invisible at the injection site, and impossible to review by
 * search. A distinct token means every class allowed to bypass tenant scoping
 * names `SYSTEM_PRISMA` in its constructor — and TAR-39 permits five of them.
 *
 * Unroutable connection strings: constructing a Prisma client opens no
 * connection, and nothing here runs a query.
 */

const APP_DATABASE_URL = 'postgresql://app:unused@127.0.0.1:1/unused';
const SYSTEM_DATABASE_URL = 'postgresql://system:unused@127.0.0.1:1/unused';

describe('PrismaModule', () => {
  let moduleRef: TestingModule;
  let tenantPrisma: TenantPrisma;
  let systemPrisma: SystemPrisma;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ APP_DATABASE_URL, SYSTEM_DATABASE_URL })],
        }),
        TenantContextModule,
        PrismaModule,
      ],
    }).compile();

    tenantPrisma = moduleRef.get<TenantPrisma>(TENANT_PRISMA);
    systemPrisma = moduleRef.get<SystemPrisma>(SYSTEM_PRISMA);
  });

  it('exposes two separate clients', () => {
    expect(tenantPrisma).toBeDefined();
    expect(systemPrisma).toBeDefined();
    expect(tenantPrisma).not.toBe(systemPrisma);
  });

  it('scopes only the tenant client — there is no bypass flag to find', () => {
    expect('$tenantTransaction' in tenantPrisma).toBe(true);
    expect('$tenantTransaction' in systemPrisma).toBe(false);
  });

  it('returns both pools on shutdown, so a rolling deploy does not strand connections', async () => {
    const tenantDisconnect = jest.spyOn(tenantPrisma, '$disconnect').mockResolvedValue(undefined);
    const systemDisconnect = jest.spyOn(systemPrisma, '$disconnect').mockResolvedValue(undefined);

    await moduleRef.close();

    expect(tenantDisconnect).toHaveBeenCalledTimes(1);
    expect(systemDisconnect).toHaveBeenCalledTimes(1);
  });
});
