import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import {
  MissingTenantContextError,
  TenantNotActiveError,
  UnscopedModelAccessError,
} from './prisma.errors';
import { TENANT_GUC, withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * What the client does *before* it reaches Postgres — the half
 * `tenant-isolation.int-spec.ts` cannot show, because a refused query leaves no
 * trace in a database.
 *
 * Nothing here connects. `$transaction` and `$executeRaw` are stubbed on the
 * un-extended client the extension closes over, and a `PrismaPromise` does no
 * work until something awaits it, so the intercepted operation is composed and
 * then dropped. The connection string is deliberately unroutable: if a stub
 * ever stopped taking effect, these tests would fail on a connection error
 * rather than quietly start talking to a real database.
 */

const UNROUTABLE = 'postgresql://unused:unused@127.0.0.1:1/unused';
const TENANT_ID = '49444444-4444-7444-8444-444444444401';

/** Distinguishable stand-ins for the two statements in the batch. */
const GUC_STATEMENT = Symbol('set_config');
const QUERY_RESULT = Symbol('query result');

describe('withTenantScope', () => {
  let tenantContext: TenantContextService;
  let base: PrismaClient;
  let prisma: TenantPrisma;
  let transaction: jest.SpyInstance;
  let executeRaw: jest.SpyInstance;

  function asTenant<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: 'spec', tenantId: TENANT_ID, userId: null, principal: null },
      async () => await work(),
    );
  }

  function asUnresolved<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: 'spec', tenantId: null, userId: null, principal: null },
      async () => await work(),
    );
  }

  beforeEach(() => {
    tenantContext = new TenantContextService();
    base = createPrismaClient('tenant', UNROUTABLE);

    executeRaw = jest.spyOn(base, '$executeRaw').mockReturnValue(GUC_STATEMENT as never);
    transaction = jest.spyOn(base, '$transaction').mockResolvedValue([1, QUERY_RESULT] as never);

    prisma = withTenantScope(base, tenantContext);
  });

  describe('the statement it prepends', () => {
    it('sets the tenant GUC transaction-locally, with the id bound as a parameter', async () => {
      await asTenant(() => prisma.contact.findMany());

      expect(executeRaw).toHaveBeenCalledTimes(1);

      const [fragments, ...values] = executeRaw.mock.calls[0] as [string[], ...unknown[]];

      // Interpolating the id into the SQL instead of binding it would be an
      // injection hole reachable from a session claim.
      //
      // The nesting is the deactivation gate (TAR-51) and its order is the
      // mechanism: Postgres evaluates `assert_tenant_active` first, so a
      // deactivated tenant raises before `set_config` runs and the GUC is never
      // set. Checking after setting it would leave a window in which the
      // statement batched behind it could still run.
      //
      // The schema qualifier is load-bearing too: unqualified, the call
      // resolves through the connection's `search_path`, and a connection
      // without `public` on it fails every tenant statement.
      expect(fragments.join('?')).toBe(
        'SELECT set_config(?, public.assert_tenant_active(?), true)',
      );
      expect(values).toEqual([TENANT_GUC, TENANT_ID]);
    });

    it('names the GUC the RLS policies actually read', () => {
      // The policies in 20260810140000_tenant_isolation_rls hardcode this
      // string. A rename on one side and not the other disables every policy
      // silently, so it is asserted rather than assumed.
      expect(TENANT_GUC).toBe('app.tenant_id');
    });

    it('sends the GUC and the query as one batched transaction', async () => {
      const result = await asTenant(() => prisma.contact.findMany());

      expect(transaction).toHaveBeenCalledTimes(1);

      const [batch] = transaction.mock.calls[0] as [unknown[]];
      expect(batch).toHaveLength(2);
      expect(batch[0]).toBe(GUC_STATEMENT);

      // The operation's own result is what the caller gets back, not the
      // `set_config` row count.
      expect(result).toBe(QUERY_RESULT);
    });

    it('covers raw SQL, which an argument-rewriting extension could not', async () => {
      await asTenant(() => prisma.$queryRaw`SELECT 1`);

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(executeRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('fail-closed', () => {
    it('rejects a read with no tenant in scope', async () => {
      await asUnresolved(async () => {
        await expect(prisma.contact.findMany()).rejects.toBeInstanceOf(MissingTenantContextError);
      });
    });

    it('rejects outside any context scope at all, as a queue worker would be', async () => {
      await expect(prisma.contact.findMany()).rejects.toBeInstanceOf(MissingTenantContextError);
    });

    it('sends nothing at all — the refusal is before the wire, not after it', async () => {
      await asUnresolved(async () => {
        await expect(
          prisma.contact.create({ data: { tenantId: TENANT_ID, phoneE164: '+1' } }),
        ).rejects.toBeInstanceOf(MissingTenantContextError);
      });

      expect(transaction).not.toHaveBeenCalled();
      expect(executeRaw).not.toHaveBeenCalled();
    });

    it('rejects $tenantTransaction with no tenant in scope, without opening one', async () => {
      await asUnresolved(async () => {
        await expect(
          prisma.$tenantTransaction(async (tx) => tx.contact.findMany()),
        ).rejects.toBeInstanceOf(MissingTenantContextError);
      });

      expect(transaction).not.toHaveBeenCalled();
    });

    it('names the model and operation it refused, so the log line locates the bug', async () => {
      const error = await asUnresolved(() => prisma.contact.findMany().catch((e: unknown) => e));

      expect(error).toBeInstanceOf(MissingTenantContextError);
      expect((error as MissingTenantContextError).message).toContain('Contact.findMany()');
    });
  });

  describe('a deactivated tenant', () => {
    /**
     * The two shapes Prisma reports a driver failure in. Which one arrives
     * depends on how the client reached the database, and the translation has
     * to survive that changing — `tenant-deactivation.int-spec.ts` proves the
     * real one against a real driver, and these pin the other.
     */
    const enginePathFailure = {
      message: 'Raw query failed',
      meta: { code: 'TN001', message: 'TENANT_NOT_ACTIVE: tenant … is suspended' },
    };
    const driverPathFailure = {
      message: 'Invalid `prisma.contact.findMany()` invocation',
      meta: {
        driverAdapterError: {
          cause: { originalMessage: 'TENANT_NOT_ACTIVE: tenant … is suspended' },
        },
      },
    };

    it.each([
      ['the engine path', enginePathFailure],
      ['the driver-adapter path', driverPathFailure],
    ])('reports the refusal from %s as a deactivated tenant, not a fault', async (_, failure) => {
      transaction.mockRejectedValue(failure);

      const error = await asTenant(() => prisma.contact.findMany().catch((e: unknown) => e));

      expect(error).toBeInstanceOf(TenantNotActiveError);
      expect((error as TenantNotActiveError).tenantId).toBe(TENANT_ID);
      expect((error as TenantNotActiveError).message).toContain('Contact.findMany()');
    });

    it('translates the same refusal inside $tenantTransaction', async () => {
      transaction.mockRejectedValue(enginePathFailure);

      const error = await asTenant(() =>
        prisma.$tenantTransaction(async (tx) => tx.contact.findMany()).catch((e: unknown) => e),
      );

      expect(error).toBeInstanceOf(TenantNotActiveError);
    });

    it('leaves every other database failure exactly as it was', async () => {
      // Translating anything that failed near the GUC would hide an outage
      // behind a 403 and stop it reaching an error tracker.
      const outage = new Error("Can't reach database server");
      transaction.mockRejectedValue(outage);

      await asTenant(async () => {
        await expect(prisma.contact.findMany()).rejects.toBe(outage);
      });
    });
  });

  describe('the three models RLS does not protect', () => {
    it('refuses to write a Tenant', async () => {
      await asTenant(async () => {
        await expect(
          prisma.tenant.update({ where: { id: TENANT_ID }, data: { name: 'x' } }),
        ).rejects.toBeInstanceOf(UnscopedModelAccessError);
      });

      expect(transaction).not.toHaveBeenCalled();
    });

    it('refuses to write a Plan', async () => {
      await asTenant(async () => {
        await expect(prisma.plan.updateMany({ data: { isActive: false } })).rejects.toBeInstanceOf(
          UnscopedModelAccessError,
        );
      });
    });

    it('refuses to read a WebhookEvent, which the app role is granted nothing on', async () => {
      await asTenant(async () => {
        await expect(prisma.webhookEvent.findMany()).rejects.toBeInstanceOf(
          UnscopedModelAccessError,
        );
      });

      expect(transaction).not.toHaveBeenCalled();
    });

    it('allows reading a Tenant and a Plan', async () => {
      await asTenant(async () => {
        await expect(prisma.tenant.findMany()).resolves.toBe(QUERY_RESULT);
        await expect(prisma.plan.findMany()).resolves.toBe(QUERY_RESULT);
      });
    });
  });
});
