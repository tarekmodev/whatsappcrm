import {
  ASSIGNMENT_POLICY,
  permissionsForRole,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { AssignmentSettingsService } from './assignment-settings.service';

/**
 * The tenant default and the agent's self-read (TAR-384, 0008 amendment 4),
 * against a fake client.
 *
 * Fake rather than mocked away: the service's real branches run — the
 * missing-row fallback, the upsert, the audit metadata — and what is faked is
 * only what the database answers. The permission gates themselves are
 * `PermissionGuard`'s and are asserted in `permission.guard.spec.ts`; what
 * matters here is that `readOwn` cannot be pointed at anybody else, which is a
 * property of the query rather than of a check.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000c1';
const CALLER = '0192f0ff-0000-7000-8000-00000000d001';
const UPDATED_AT = new Date('2026-08-20T10:30:00.000Z');

interface FakeState {
  /** The tenant's settings row, or `null` for a tenant that predates provisioning writing one. */
  settings: { defaultMaxConcurrentTickets: number } | null;
  /** The caller's own `users.max_concurrent_tickets`. */
  ownCap?: number | null;
  /** Active tickets the caller holds. */
  ownActiveTickets?: number;
}

interface Recorded {
  audits: { action: string; targetType: string; targetId: string; metadata?: unknown }[];
  upserts: { create: unknown; update: unknown }[];
}

function buildService(state: FakeState): {
  settings: AssignmentSettingsService;
  recorded: Recorded;
  tenantContext: TenantContextService;
} {
  const recorded: Recorded = { audits: [], upserts: [] };

  const tx = {
    tenantSettings: {
      findUnique: () => Promise.resolve(state.settings),
      upsert: ({ create, update }: { create: unknown; update: Record<string, unknown> }) => {
        recorded.upserts.push({ create, update });

        return Promise.resolve({
          defaultMaxConcurrentTickets: update.defaultMaxConcurrentTickets as number,
          updatedAt: UPDATED_AT,
        });
      },
    },
    auditLog: { create: () => Promise.resolve({}) },
  };

  const prisma = {
    tenantSettings: {
      findUnique: () =>
        Promise.resolve(
          state.settings === null ? null : { ...state.settings, updatedAt: UPDATED_AT },
        ),
    },
    user: {
      findUnique: () => Promise.resolve({ maxConcurrentTickets: state.ownCap ?? null }),
    },
    ticket: {
      groupBy: () =>
        Promise.resolve(
          (state.ownActiveTickets ?? 0) === 0
            ? []
            : [{ assignedUserId: CALLER, _count: { _all: state.ownActiveTickets } }],
        ),
    },
    $tenantTransaction: (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as TenantPrisma;

  const audit = {
    record: (
      _tx: unknown,
      entry: { action: string; targetType: string; targetId: string; metadata?: unknown },
    ) => {
      recorded.audits.push(entry);

      return Promise.resolve();
    },
  } as unknown as AuditService;

  const tenantContext = new TenantContextService();

  return {
    settings: new AssignmentSettingsService(prisma, tenantContext, audit),
    recorded,
    tenantContext,
  };
}

function principalFor(role: 'agent' | 'supervisor' | 'admin'): SessionPrincipal {
  return {
    userId: CALLER,
    tenantId: TENANT,
    email: `${role}@example.invalid`,
    displayName: role,
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: '0192f0ff-0000-7000-8000-0000000000fe',
    expiresAt: '2026-12-31T23:59:59.000Z',
  };
}

async function asPrincipal<T>(
  tenantContext: TenantContextService,
  role: 'agent' | 'supervisor' | 'admin',
  work: () => Promise<T>,
): Promise<T> {
  return tenantContext.run(
    {
      requestId: 'test-request',
      tenantId: TENANT,
      userId: CALLER,
      principal: principalFor(role),
    },
    work,
  );
}

describe('AssignmentSettingsService — the tenant default', () => {
  describe('reading it', () => {
    it('reports the configured value and when the row last moved', async () => {
      const { settings, tenantContext } = buildService({
        settings: { defaultMaxConcurrentTickets: 12 },
      });

      const response = await asPrincipal(tenantContext, 'supervisor', () => settings.read());

      expect(response).toEqual({
        defaultMaxConcurrentTickets: 12,
        updatedAt: UPDATED_AT.toISOString(),
      });
    });

    it('answers the built-in fallback for a tenant with no settings row, not a 404', async () => {
      const { settings, tenantContext } = buildService({ settings: null });

      const response = await asPrincipal(tenantContext, 'supervisor', () => settings.read());

      // That tenant has a working effective default — the same number the
      // resolver coalesces to — and a 404 would say otherwise.
      expect(response).toEqual({
        defaultMaxConcurrentTickets: ASSIGNMENT_POLICY.defaultMaxConcurrentTickets,
        updatedAt: null,
      });
    });
  });

  describe('writing it', () => {
    it('upserts, so the first write on a legacy tenant creates the row', async () => {
      const { settings, recorded, tenantContext } = buildService({ settings: null });

      await asPrincipal(tenantContext, 'supervisor', () =>
        settings.update({ defaultMaxConcurrentTickets: 7 }),
      );

      expect(recorded.upserts).toEqual([
        {
          // `tenantId` explicit: the tenant-scope extension sets the GUC but
          // does not inject the column, and the RLS `WITH CHECK` needs it.
          create: { tenantId: TENANT, defaultMaxConcurrentTickets: 7 },
          update: { defaultMaxConcurrentTickets: 7 },
        },
      ]);
    });

    it('audits the move against the tenant, with null for “there was no row”', async () => {
      const { settings, recorded, tenantContext } = buildService({ settings: null });

      await asPrincipal(tenantContext, 'admin', () =>
        settings.update({ defaultMaxConcurrentTickets: 7 }),
      );

      expect(recorded.audits).toEqual([
        {
          action: 'assignment_settings.updated',
          targetType: 'tenant_settings',
          targetId: TENANT,
          metadata: { from: null, to: 7 },
        },
      ]);
    });

    it('audits a no-op write too, because the trail is what says a value was chosen', async () => {
      const { settings, recorded, tenantContext } = buildService({
        settings: { defaultMaxConcurrentTickets: 5 },
      });

      await asPrincipal(tenantContext, 'supervisor', () =>
        settings.update({ defaultMaxConcurrentTickets: 5 }),
      );

      // Suppressing this would lose the first deliberate choice that happened to
      // match the column default — the one fact `tenant_settings.updated_at`
      // cannot answer.
      expect(recorded.audits).toEqual([
        {
          action: 'assignment_settings.updated',
          targetType: 'tenant_settings',
          targetId: TENANT,
          metadata: { from: 5, to: 5 },
        },
      ]);
    });
  });
});

describe('AssignmentSettingsService — an agent reading their own capacity', () => {
  it('reports the override, the effective cap and the live load', async () => {
    const { settings, tenantContext } = buildService({
      settings: { defaultMaxConcurrentTickets: 5 },
      ownCap: 9,
      ownActiveTickets: 4,
    });

    const response = await asPrincipal(tenantContext, 'agent', () => settings.readOwn());

    expect(response).toEqual({
      maxConcurrentTickets: 9,
      effectiveMaxConcurrentTickets: 9,
      activeTicketCount: 4,
      defaultMaxConcurrentTickets: 5,
    });
  });

  it('inherits the tenant default when the agent has no override', async () => {
    const { settings, tenantContext } = buildService({
      settings: { defaultMaxConcurrentTickets: 6 },
      ownCap: null,
    });

    const response = await asPrincipal(tenantContext, 'agent', () => settings.readOwn());

    expect(response).toEqual({
      maxConcurrentTickets: null,
      effectiveMaxConcurrentTickets: 6,
      activeTicketCount: 0,
      defaultMaxConcurrentTickets: 6,
    });
  });

  it('falls back to the built-in default on a tenant with no settings row', async () => {
    const { settings, tenantContext } = buildService({ settings: null, ownCap: null });

    const response = await asPrincipal(tenantContext, 'agent', () => settings.readOwn());

    expect(response.effectiveMaxConcurrentTickets).toBe(
      ASSIGNMENT_POLICY.defaultMaxConcurrentTickets,
    );
  });
});
