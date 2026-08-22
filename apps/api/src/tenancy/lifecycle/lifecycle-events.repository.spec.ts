import type { SystemPrisma } from '../../prisma/prisma.tokens';
import { LifecycleEventsRepository } from './lifecycle-events.repository';
import { InvalidLifecycleCursorError } from './tenant-lifecycle.errors';

/**
 * The only reader of `lifecycle_events`, and the reason it is only one.
 *
 * The table has no `tenant_isolation` policy by design — it survives the purge
 * and stays readable after the tenant is no longer serviceable — so **nothing in
 * the database narrows this read**. The narrowing is the `where` clause below,
 * and these are the assertions that it is there, that it comes from the
 * argument, and that the tenant-facing projection withholds `reason`.
 *
 * `lifecycle-events.int-spec.ts` proves the same thing against a real database
 * with two tenants' rows in the table. This proves the query shape.
 */

const TENANT_ID = '5f111111-1111-7111-8111-111111111101';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '5f111111-1111-7111-8111-1111111111e1',
    fromState: 'active',
    toState: 'suspended',
    trigger: 'operator_action',
    actorType: 'platform_operator',
    actorLabel: 'ops-alice',
    reason: 'Fraud, card chargeback',
    occurredAt: new Date('2026-08-16T12:00:00.000Z'),
    ...overrides,
  };
}

describe('LifecycleEventsRepository', () => {
  let findMany: jest.Mock;
  let repository: LifecycleEventsRepository;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([row()]);

    repository = new LifecycleEventsRepository({
      lifecycleEvent: { findMany },
    } as unknown as SystemPrisma);
  });

  it('narrows to the tenant it was given, and nothing else does', async () => {
    await repository.forTenant(TENANT_ID, { limit: 25 });

    const [{ where }] = findMany.mock.calls[0] as [{ where: Record<string, unknown> }];

    // The whole isolation guarantee for this table, in one clause. It arrives as
    // an argument — from `principal.tenantId` — and never from a request body,
    // query or path.
    expect(where.tenantId).toBe(TENANT_ID);
  });

  it('withholds `reason` from the tenant', async () => {
    const page = await repository.forTenant(TENANT_ID, { limit: 25 });

    // `reason` is where an operator writes "fraud, card chargeback". 0009's
    // security section says that is not a sentence to show a customer.
    expect(page.items[0]).not.toHaveProperty('reason');
    expect(page.items[0]).toMatchObject({ fromStatus: 'active', toStatus: 'suspended' });
  });

  it('gives `reason` to the operator, which is the point of two projections', async () => {
    const page = await repository.forOperator(TENANT_ID, { limit: 25 });

    expect(page.items[0]?.reason).toBe('Fraud, card chargeback');
  });

  it('never carries `metadata` to either reader', async () => {
    // It holds a provider event id and elapsed-timer measurements — platform
    // forensics rather than anything either caller renders — so it is not even
    // selected.
    const [{ select }] = findMany.mock.calls.length
      ? (findMany.mock.calls[0] as [{ select: Record<string, boolean> }])
      : [{ select: {} }];

    await repository.forOperator(TENANT_ID, { limit: 25 });

    const [{ select: operatorSelect }] = findMany.mock.calls.at(-1) as [
      { select: Record<string, boolean> },
    ];

    expect(select.metadata).toBeUndefined();
    expect(operatorSelect.metadata).toBeUndefined();
  });

  it('reads newest first, on the index that exists for this query', async () => {
    await repository.forTenant(TENANT_ID, { limit: 25 });

    const [{ orderBy }] = findMany.mock.calls[0] as [{ orderBy: unknown }];

    expect(orderBy).toEqual([{ occurredAt: 'desc' }, { id: 'desc' }]);
  });

  it('takes one row more than asked for, so the cursor is answered by the query', async () => {
    await repository.forTenant(TENANT_ID, { limit: 25 });

    const [{ take }] = findMany.mock.calls[0] as [{ take: number }];

    expect(take).toBe(26);
  });

  it('reports no next page when the extra row is not there', async () => {
    findMany.mockResolvedValue([row(), row({ id: 'b' })]);

    const page = await repository.forTenant(TENANT_ID, { limit: 25 });

    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(2);
  });

  it('issues a cursor only when there genuinely is more', async () => {
    findMany.mockResolvedValue([row(), row({ id: 'b' }), row({ id: 'c' })]);

    const page = await repository.forTenant(TENANT_ID, { limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it('resumes strictly after the cursor row, keeping its tie group intact', async () => {
    findMany.mockResolvedValue([row(), row({ id: 'b' })]);

    const first = await repository.forTenant(TENANT_ID, { limit: 1 });

    expect(first.nextCursor).not.toBeNull();

    await repository.forTenant(TENANT_ID, { limit: 1, cursor: first.nextCursor ?? undefined });

    const [{ where }] = findMany.mock.calls.at(-1) as [
      { where: { occurredAt?: unknown; NOT?: unknown } },
    ];

    // The inclusive bound plus the tie-group exclusion, rather than
    // `(at, id) < ($1, $2)` written as a conjunction — which returns the same
    // rows for most inputs and silently drops one at every boundary.
    expect(where.occurredAt).toBeDefined();
    expect(where.NOT).toBeDefined();
  });

  it('refuses a cursor this build cannot read, rather than re-serving page one', async () => {
    await expect(
      repository.forTenant(TENANT_ID, { limit: 25, cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvalidLifecycleCursorError);
  });
});
