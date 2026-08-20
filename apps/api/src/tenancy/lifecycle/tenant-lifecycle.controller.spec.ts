import 'reflect-metadata';
import type { TenantLifecycleResponse } from '@whatsappcrm/contracts';
import { ApiException } from '../../common/errors/api.exception';
import { AVAILABLE_WHILE_SUSPENDED } from '../../common/request-pipeline/route-access';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import { REQUIRED_PERMISSIONS } from '../../rbac/require-permission.decorator';
import type { LifecycleEventsRepository } from './lifecycle-events.repository';
import { TenantLifecycleController } from './tenant-lifecycle.controller';
import type { TenantLifecycleReader } from './tenant-lifecycle.reader';
import { InvalidTenantTransitionError } from './tenant-lifecycle.errors';
import type { TenantLifecycleService } from './tenant-lifecycle.service';

/**
 * The five tenant-facing lifecycle routes: what they pass to the engine, what
 * they refuse before it, and the two decorators on each that decide who can
 * reach them at all.
 *
 * The last block is the one worth having. `@AvailableWhileSuspended()` and the
 * permission are the entire access-control story for these routes, and both are
 * one deleted line away from being wrong in a way no other test would notice —
 * a missing decorator makes a route unreachable for the tenant it exists to
 * rescue, and a spurious one opens a write from behind a lockout.
 */

const TENANT_ID = '5a111111-1111-7111-8111-111111111101';

const LIFECYCLE: TenantLifecycleResponse = {
  status: 'trialing',
  trialEndsAt: '2026-08-30T00:00:00.000Z',
  gracePeriodEndsAt: null,
  purgeAt: null,
  plan: {
    key: 'trial',
    name: 'Trial',
    entitlements: {
      features: ['assignment_rules'],
      limits: {
        seats: 3,
        conversationsPerPeriod: 1000,
        whatsappNumbers: 1,
        teams: 2,
        knowledgeDocuments: 10,
      },
    },
  },
  usage: { seatsUsed: 2, seatsPending: 1, conversationsThisPeriod: 12 },
};

describe('TenantLifecycleController', () => {
  let transition: jest.Mock;
  let state: jest.Mock;
  let read: jest.Mock;
  let forTenant: jest.Mock;
  let tenantContext: TenantContextService;
  let controller: TenantLifecycleController;

  beforeEach(() => {
    transition = jest.fn().mockResolvedValue({ transitioned: true, eventId: 'event' });
    state = jest
      .fn()
      .mockResolvedValue({ id: TENANT_ID, slug: 'acme', name: 'Acme Ltd', status: 'trialing' });
    read = jest.fn().mockResolvedValue(LIFECYCLE);
    forTenant = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    tenantContext = new TenantContextService();

    controller = new TenantLifecycleController(
      { transition, state } as unknown as TenantLifecycleService,
      { read } as unknown as TenantLifecycleReader,
      { forTenant } as unknown as LifecycleEventsRepository,
      tenantContext,
    );
  });

  /** Runs `work` as if the pipeline had resolved a tenant and an admin. */
  function asTenant<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      {
        requestId: 'req_lifecycle',
        tenantId: TENANT_ID,
        userId: '5a111111-1111-7111-8111-1111111111a1',
      },
      work,
    );
  }

  describe('the read', () => {
    it('renders the tenant in scope, never one the caller named', async () => {
      const response = await asTenant(() => controller.read());

      expect(read).toHaveBeenCalledWith(TENANT_ID);
      expect(response).toEqual(LIFECYCLE);
    });

    it('takes the events list’s tenant from the session too', async () => {
      await asTenant(() => controller.list({ limit: 25 }));

      expect(forTenant).toHaveBeenCalledWith(TENANT_ID, { limit: 25 });
    });
  });

  describe('cancelling', () => {
    it('is a `user_action`, attributed to the admin who pressed it', async () => {
      await asTenant(() => controller.cancel({ reason: 'Too expensive' }));

      expect(transition).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        to: 'cancelled',
        trigger: 'user_action',
        actor: {
          actorType: 'user',
          actorUserId: '5a111111-1111-7111-8111-1111111111a1',
          actorLabel: null,
        },
        reason: 'Too expensive',
      });
    });

    it('re-reads the response, so the panel never renders a half-populated object', async () => {
      const response = await asTenant(() => controller.cancel({}));

      expect(read).toHaveBeenCalledWith(TENANT_ID);
      expect(response).toEqual(LIFECYCLE);
    });

    it('reports a refusal from the state machine as a conflict', async () => {
      transition.mockRejectedValue(
        new InvalidTenantTransitionError('deleted', 'cancelled', 'user_action', 'edge_not_allowed'),
      );

      const failure = await asTenant(() =>
        controller.cancel({}).catch((error: unknown) => error as ApiException),
      );

      expect(failure).toBeInstanceOf(ApiException);
      expect((failure as ApiException).code).toBe('conflict');
    });
  });

  describe('undoing a cancellation', () => {
    it('goes back to `active` on the same trigger', async () => {
      await asTenant(() => controller.undoCancel());

      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'active', trigger: 'user_action' }),
      );
    });

    it('is refused once the grace period has run out', async () => {
      // Past `cancelledGraceDays` the tenant is `suspended`, and
      // `suspended → active` on a `user_action` is not an edge the state machine
      // has: the way back from there is a payment or an operator.
      transition.mockRejectedValue(
        new InvalidTenantTransitionError(
          'suspended',
          'active',
          'user_action',
          'trigger_not_allowed',
        ),
      );

      const failure = await asTenant(() =>
        controller.undoCancel().catch((error: unknown) => error as ApiException),
      );

      expect((failure as ApiException).code).toBe('conflict');
    });
  });

  describe('requesting deletion', () => {
    it('refuses a slug that does not match, before anything is written', async () => {
      const failure = await asTenant(() =>
        controller
          .requestDeletion({ confirmSlug: 'acme-ltd' })
          .catch((error: unknown) => error as ApiException),
      );

      expect((failure as ApiException).code).toBe('validation_failed');
      expect(transition).not.toHaveBeenCalled();
    });

    it('schedules rather than deleting, so the retention window still runs', async () => {
      await asTenant(() => controller.requestDeletion({ confirmSlug: 'acme' }));

      // `cancelled`, not `deleted`: the tenant reaches `suspended` when the
      // cancellation grace period elapses and is purged 30 days after that.
      // TAR-36 asks for the window, and an endpoint that destroyed data
      // synchronously would have none.
      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'cancelled', trigger: 'user_action' }),
      );
    });

    it('checks the slug server-side, against the tenant’s own record', async () => {
      await asTenant(() => controller.requestDeletion({ confirmSlug: 'acme' }));

      // The client having asked nicely is not the check.
      expect(state).toHaveBeenCalledWith(TENANT_ID);
    });
  });

  describe('the postures each route declares', () => {
    /**
     * The metadata a decorator left on one handler.
     *
     * Read straight off the prototype with `Reflect.getMetadata`, which is what
     * `Reflector` does underneath and what `route-posture.spec.ts` already walks
     * the source tree with. The handler is never called — only inspected — which
     * is why `unbound-method` is suppressed here rather than worked around.
     */
    function metadataOf<T>(key: string, method: keyof TenantLifecycleController): T | undefined {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const handler = TenantLifecycleController.prototype[method];

      return Reflect.getMetadata(key, handler) as T | undefined;
    }

    it.each([
      ['read', true],
      ['list', true],
      ['undoCancel', true],
      ['cancel', false],
      ['requestDeletion', false],
    ] as const)('marks %s available while suspended: %s', (method, expected) => {
      expect(metadataOf<boolean>(AVAILABLE_WHILE_SUSPENDED, method) === true).toBe(expected);
    });

    it('gates the reads on `tenant:settings` and the writes on `billing:manage`', () => {
      const permissionsOf = (
        method: keyof TenantLifecycleController,
      ): readonly string[] | undefined => metadataOf(REQUIRED_PERMISSIONS, method);

      expect(permissionsOf('read')).toEqual(['tenant:settings']);
      expect(permissionsOf('list')).toEqual(['tenant:settings']);
      // Ending a tenant's life on `billing:manage` rather than a new
      // `tenant:delete` is a deliberate narrowing: the two people who can end a
      // tenant's subscription are the two who can end the tenant.
      expect(permissionsOf('cancel')).toEqual(['billing:manage']);
      expect(permissionsOf('requestDeletion')).toEqual(['billing:manage']);
    });
  });
});
