import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  MessageTemplateAdminPageSchema,
  permissionsForRole,
  type SessionPrincipal,
  type TenantRole,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { PermissionGuard } from '../rbac/permission.guard';
import { PrincipalGuard } from '../rbac/principal.guard';
import { ANONYMOUS, PRINCIPAL_SOURCE, resolved } from '../rbac/principal.source';
import { MessageTemplateAdministrationController } from './message-template-administration.controller';
import { MessageTemplateAdministrationService } from './message-template-administration.service';
import { InvalidCursorError } from './message-template-cursor';

/**
 * The HTTP contract of `GET /api/v1/whatsapp/message-templates`.
 *
 * Two assertions carry the story. The permission one: an agent — who may send,
 * and therefore reads the composer's list all day — is refused here, because
 * this surface publishes the templates that list deliberately hides and belongs
 * to whoever manages the channel. And the sendability one: an approved template
 * the composer cannot fill comes back present and marked, not absent. The whole
 * story is that a template is never silently missing.
 *
 * Proved with the **real** `PrincipalGuard` and `PermissionGuard`, registered as
 * `APP_GUARD` the way `RequestPipelineModule` registers them, and a fake
 * principal source in place of the session read. `HostTenantGuard` needs a
 * database, so the middleware below stands in for it.
 */

const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';
const TENANT_ID = '50444444-4444-7444-8444-4444444444c1';
const TIMESTAMP = new Date('2026-08-10T09:00:00.000Z');

function listed(name: string, status: string, requiresButtonParameters: boolean) {
  return {
    row: {
      id: '80444444-4444-7444-8444-444444444401',
      whatsappBusinessAccountId: WABA_ROW_ID,
      name,
      language: 'en_US',
      category: 'UTILITY',
      status,
      components: [{ type: 'BODY', text: 'Hello.' }],
      providerTemplateId: '1001',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    summary: {
      bodyText: 'Hello.',
      parameterCount: 0,
      headerFormat: null,
      headerParameterCount: 0,
      requiresButtonParameters,
    },
  };
}

function principal(role: TenantRole): SessionPrincipal {
  return {
    userId: '50444444-4444-7444-8444-4444444444a1',
    tenantId: TENANT_ID,
    email: `${role}@example.invalid`,
    displayName: 'Ada Admin',
    role,
    permissions: [...permissionsForRole(role)],
    teamIds: [],
    sessionId: '50444444-4444-7444-8444-4444444444f1',
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

describe('GET /api/v1/whatsapp/message-templates', () => {
  let app: INestApplication;
  let server: Server;
  let list: jest.Mock;
  let caller: SessionPrincipal | null;

  beforeAll(async () => {
    list = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [MessageTemplateAdministrationController],
      providers: [
        ApiExceptionFilter,
        { provide: MessageTemplateAdministrationService, useValue: { list } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PRINCIPAL_SOURCE,
          useValue: {
            resolve: () => Promise.resolve(caller === null ? ANONYMOUS : resolved(caller)),
          },
        },
        { provide: APP_GUARD, useClass: PrincipalGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    const middleware = app.get(TenantContextMiddleware);
    const tenantContext = app.get(TenantContextService);

    app.use(middleware.use.bind(middleware));
    app.use((_request: unknown, _response: unknown, next: () => void) => {
      tenantContext.setTenant(TENANT_ID);
      next();
    });

    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    caller = principal('admin');
    list
      .mockReset()
      .mockResolvedValue({ items: [listed('order_update', 'approved', false)], nextCursor: null });
  });

  function get(query = '') {
    return request(server).get(`/api/v1/whatsapp/message-templates${query}`);
  }

  it('refuses a request with no session, without reaching a query', async () => {
    caller = null;

    const response = await get();

    expect(response.status).toBe(401);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
    expect(list).not.toHaveBeenCalled();
  });

  it.each(['agent', 'supervisor'] as const)(
    'refuses a signed-in %s, who has no channel:manage',
    async (role) => {
      // Both may send, and therefore read the composer's list. Neither manages
      // the channel, and this surface is the channel's configuration.
      caller = principal(role);

      const response = await get();

      expect(response.status).toBe(403);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('forbidden');
      expect(list).not.toHaveBeenCalled();
    },
  );

  it('returns the published page shape', async () => {
    const response = await get();

    expect(MessageTemplateAdminPageSchema.parse(response.body)).toMatchObject({
      items: [{ name: 'order_update', status: 'approved', sendable: true, sendBlockers: [] }],
      nextCursor: null,
    });
  });

  it('shows a template Meta has not approved, with its status', async () => {
    // The composer's list has no way to return this row at all.
    list.mockResolvedValue({ items: [listed('welcome', 'rejected', false)], nextCursor: null });

    const response = await get();

    expect(MessageTemplateAdminPageSchema.parse(response.body).items[0]).toMatchObject({
      status: 'rejected',
      sendable: false,
      sendBlockers: ['meta_not_approved'],
    });
  });

  it('shows an approved template the composer cannot fill, and says which limit it is', async () => {
    // "Approved by Meta, not yet sendable from this product" — the state
    // amendment 1 leans on this surface to make visible.
    list.mockResolvedValue({ items: [listed('order_update', 'approved', true)], nextCursor: null });

    const response = await get();

    expect(MessageTemplateAdminPageSchema.parse(response.body).items[0]).toMatchObject({
      status: 'approved',
      requiresButtonParameters: true,
      sendable: false,
      sendBlockers: ['button_parameters_required'],
    });
  });

  it('reports both reasons when a template is blocked twice', async () => {
    // Otherwise an administrator waits for a Meta approval that will not put the
    // template in the picker.
    list.mockResolvedValue({ items: [listed('order_update', 'pending', true)], nextCursor: null });

    const response = await get();

    expect(MessageTemplateAdminPageSchema.parse(response.body).items[0]?.sendBlockers).toEqual([
      'meta_not_approved',
      'button_parameters_required',
    ]);
  });

  it('applies the documented default page size', async () => {
    await get();

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  it('passes the status filter through, which narrows what is shown', async () => {
    await get('?status=rejected');

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
  });

  it('passes the business-account filter through', async () => {
    await get(`?whatsappBusinessAccountId=${WABA_ROW_ID}`);

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ whatsappBusinessAccountId: WABA_ROW_ID }),
    );
  });

  it('passes the name prefix through', async () => {
    await get('?q=order');

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: 'order' }));
  });

  it.each([
    ['a limit above the cap', '?limit=1000'],
    ['a limit below one', '?limit=0'],
    ['a WABA id that is not a uuid', '?whatsappBusinessAccountId=nope'],
    ['a status outside the published set', '?status=archived'],
    ['an empty name prefix', '?q='],
  ])('rejects %s', async (_case, query) => {
    const response = await get(query);

    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
    expect(list).not.toHaveBeenCalled();
  });

  it('reports a corrupted cursor as bad input rather than as a fault', async () => {
    list.mockRejectedValue(new InvalidCursorError());

    const response = await get('?cursor=nonsense');

    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(response.body).error.details?.[0]?.path).toBe('cursor');
  });

  it('reports a deactivated tenant as forbidden, not as a server fault', async () => {
    list.mockRejectedValue(new TenantNotActiveError(TENANT_ID, 'findMany', 'MessageTemplate'));

    const response = await get();

    expect(response.status).toBe(403);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('forbidden');
  });
});
