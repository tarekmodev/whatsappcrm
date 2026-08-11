import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { AUDIT_ACTIONS } from './audit.actions';
import { AuditService } from './audit.service';

/**
 * Who an audit row says acted, which is the only thing this service decides:
 * everything else in the entry is the caller's, and the transaction is the
 * caller's too.
 */

const TENANT_ID = '50444444-4444-7444-8444-4444444444d1';
const USER_ID = '80444444-4444-7444-8444-4444444444d1';
const TARGET_ID = '90444444-4444-7444-8444-4444444444d1';

interface WriteArgs {
  data: Record<string, unknown>;
}

describe('AuditService', () => {
  let create: jest.Mock;
  let tx: Prisma.TransactionClient;
  let tenantContext: TenantContextService;
  let service: AuditService;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue({ id: 'audit' });
    tx = { auditLog: { create } } as unknown as Prisma.TransactionClient;
    tenantContext = new TenantContextService();
    service = new AuditService(tenantContext);
  });

  function inScope<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: 'req_audit', tenantId: null, userId: null, principal: null },
      work,
    );
  }

  function written(): Record<string, unknown> {
    const [call] = create.mock.calls as [WriteArgs][];

    if (call === undefined) {
      throw new Error('nothing was written');
    }

    return call[0].data;
  }

  async function recordTeamCreated(): Promise<void> {
    await service.record(tx, {
      action: AUDIT_ACTIONS.teamCreated,
      targetType: 'team',
      targetId: TARGET_ID,
    });
  }

  it('attributes a session-authenticated change to the user who made it', async () => {
    await inScope(async () => {
      tenantContext.setTenant(TENANT_ID, USER_ID);

      await recordTeamCreated();
    });

    expect(written()).toMatchObject({
      tenantId: TENANT_ID,
      actorType: 'user',
      actorUserId: USER_ID,
      actorLabel: null,
    });
  });

  it('attributes an operator change to the credential that authenticated it', async () => {
    await inScope(async () => {
      tenantContext.setPlatformActor('ops-alice');
      tenantContext.setTenant(TENANT_ID);

      await recordTeamCreated();
    });

    // `actor_user_id` stays null — the operator is not a row in this tenant's
    // `users` — and `actor_label` is what stops that meaning "nobody knows".
    expect(written()).toMatchObject({
      actorType: 'platform_operator',
      actorUserId: null,
      actorLabel: 'ops-alice',
    });
  });

  it('attributes work with no caller behind it to the platform itself', async () => {
    await inScope(async () => {
      tenantContext.setTenant(TENANT_ID);

      await recordTeamCreated();
    });

    // `system`, never `unattributed`: that value describes rows written before
    // attribution existed, and a new row cannot truthfully claim it.
    expect(written()).toMatchObject({
      actorType: 'system',
      actorUserId: null,
      actorLabel: null,
    });
  });

  it('prefers the operator credential over anything else on the scope', async () => {
    await inScope(async () => {
      tenantContext.setTenant(TENANT_ID, USER_ID);
      tenantContext.setPlatformActor('ops-alice');

      await recordTeamCreated();
    });

    // The two cannot both appear on a real request — the operator surface has
    // no session — but if a later path ever carried both, the row must name the
    // credential that actually authenticated it.
    expect(written()).toMatchObject({
      actorType: 'platform_operator',
      actorUserId: null,
      actorLabel: 'ops-alice',
    });
  });

  it('writes all three attribution columns rather than leaning on the column default', async () => {
    await inScope(async () => {
      tenantContext.setTenant(TENANT_ID, USER_ID);

      await recordTeamCreated();
    });

    // `actor_type` defaults to `unattributed` in the database, and that default
    // exists only so an instance predating this release keeps writing valid
    // rows during a rollout.
    expect(Object.keys(written())).toEqual(
      expect.arrayContaining(['actorType', 'actorUserId', 'actorLabel']),
    );
  });

  it('refuses to write outside a tenant scope rather than filing it under nothing', async () => {
    await expect(inScope(() => recordTeamCreated())).rejects.toThrow('No tenant in scope');
    expect(create).not.toHaveBeenCalled();
  });

  it('omits metadata entirely when the caller gave none', async () => {
    await inScope(async () => {
      tenantContext.setTenant(TENANT_ID, USER_ID);

      await recordTeamCreated();
    });

    expect(written()).not.toHaveProperty('metadata');
  });
});
