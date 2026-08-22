import { Logger } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import type { WebhookEventsRepository } from '../webhook-events.repository';
import { WebhookEventReplayService } from './webhook-event-replay.service';

/**
 * Who a replay is attributed to, and where that answer comes from.
 *
 * The whole reason this service exists is that the trail's actor is read from
 * the request scope rather than taken from the caller — so the assertions here
 * are about the scope, not about the reset. What the reset does to the row is
 * `webhook-ingestion.int-spec.ts`, against a real database.
 */

const EVENT_ID = '94444444-4444-7444-8444-4444444444e2';
const REQUEST_ID = 'tar94-service-spec';

describe('replaying a parked webhook event', () => {
  const tenantContext = new TenantContextService();

  let replay: jest.Mock;
  let service: WebhookEventReplayService;

  beforeEach(() => {
    replay = jest.fn().mockResolvedValue({
      kind: 'replayed',
      event: {
        id: EVENT_ID,
        provider: 'whatsapp',
        parkedError: 'tenant_not_active: acme',
        replayedAt: new Date('2026-08-23T09:00:00.000Z'),
      },
    });

    service = new WebhookEventReplayService(
      { replay } as unknown as WebhookEventsRepository,
      tenantContext,
    );

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A request as `PlatformAdminGuard` leaves it: a label, and no tenant. */
  function asOperator<T>(label: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId: null, userId: null, platformActorLabel: label },
      work,
    );
  }

  it('attributes the replay to the credential that authenticated the request', async () => {
    await asOperator('ops-alice', async () => await service.replay(EVENT_ID));

    expect(replay).toHaveBeenCalledWith(EVENT_ID, 'ops-alice');
  });

  it('records the outcome the repository reported, unchanged', async () => {
    replay.mockResolvedValue({ kind: 'not-parked', status: 'received' });

    await expect(
      asOperator('ops-alice', async () => await service.replay(EVENT_ID)),
    ).resolves.toEqual({ kind: 'not-parked', status: 'received' });
  });

  it('refuses outright when no operator is in scope, rather than writing an unattributed row', async () => {
    // Unreachable behind the guard. Asserted because the failure mode if it ever
    // became reachable is the one thing this table must not do: record a replay
    // it cannot name anybody for.
    await expect(
      tenantContext.run(
        { requestId: REQUEST_ID, tenantId: null, userId: null },
        async () => await service.replay(EVENT_ID),
      ),
    ).rejects.toThrow('no platform actor in scope');

    expect(replay).not.toHaveBeenCalled();
  });

  it('logs the replay with the operator and the reason being recovered', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');

    await asOperator('ci-runbook', async () => await service.replay(EVENT_ID));

    expect(log).toHaveBeenCalledWith(expect.stringContaining('ci-runbook'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('tenant_not_active: acme'));
  });

  it('logs a refusal at warn, because an operator mid-incident will ask why', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');

    replay.mockResolvedValue({ kind: 'not-found' });

    await asOperator('ops-alice', async () => await service.replay(EVENT_ID));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no such event'));
  });
});
