import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorSchema,
  MessageTemplatePageSchema,
  permissionsForRole,
  type SessionPrincipal,
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
import { InvalidCursorError } from './message-template-cursor';
import {
  MessageTemplateQueryService,
  UnknownWhatsAppAccountError,
} from './message-template-query.service';
import { MessageTemplatesController } from './message-templates.controller';

/**
 * The HTTP contract of `GET /api/v1/message-templates`.
 *
 * The load-bearing assertion is the first one: with no session, the endpoint
 * answers 401 and never reaches a query. There is no path from an
 * unauthenticated request to a row.
 *
 * It is proved with the **real** `PrincipalGuard` and `PermissionGuard`,
 * registered as `APP_GUARD` the way `RequestPipelineModule` registers them, and
 * a fake principal source in place of the session read (TAR-58). Before that
 * story this controller had no guards at all and stood on a hand-written tenant
 * check; the point of asserting against the shipped guards is that the same
 * refusal now comes from the pipeline rather than from this class remembering.
 *
 * `HostTenantGuard` needs a database, so the middleware below stands in for it —
 * one `setTenant` call, which is all that guard contributes.
 */

const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';
const ACCOUNT_ROW_ID = '70444444-4444-7444-8444-444444444401';
const TENANT_ID = '50444444-4444-7444-8444-4444444444c1';
const TIMESTAMP = new Date('2026-08-10T09:00:00.000Z');

const TEMPLATE = {
  row: {
    id: '80444444-4444-7444-8444-444444444401',
    whatsappBusinessAccountId: WABA_ROW_ID,
    name: 'order_update',
    language: 'en_US',
    category: 'UTILITY',
    status: 'approved' as const,
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Order {{1}} ships {{2}}' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Visit', url: 'https://example.test' }] },
    ],
    providerTemplateId: '1001',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
  // Derived by the query service in the same pass that applies the button
  // exclusion, so the controller maps rather than parses.
  summary: {
    bodyText: 'Order {{1}} ships {{2}}',
    parameterCount: 2,
    headerFormat: 'image' as const,
    headerParameterCount: 0,
    requiresButtonParameters: false,
  },
};

const PRINCIPAL: SessionPrincipal = {
  userId: '50444444-4444-7444-8444-4444444444a1',
  tenantId: TENANT_ID,
  email: 'agent@example.invalid',
  displayName: 'Ada Agent',
  role: 'agent',
  permissions: [...permissionsForRole('agent')],
  teamIds: [],
  sessionId: '50444444-4444-7444-8444-4444444444f1',
  expiresAt: '2036-12-31T23:59:59.000Z',
};

describe('GET /api/v1/message-templates', () => {
  let app: INestApplication;
  let server: Server;
  let list: jest.Mock;
  let signedIn: boolean;

  beforeAll(async () => {
    list = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [MessageTemplatesController],
      providers: [
        ApiExceptionFilter,
        { provide: MessageTemplateQueryService, useValue: { list } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PRINCIPAL_SOURCE,
          useValue: { resolve: () => Promise.resolve(signedIn ? resolved(PRINCIPAL) : ANONYMOUS) },
        },
        { provide: APP_GUARD, useClass: PrincipalGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    const middleware = app.get(TenantContextMiddleware);
    const tenantContext = app.get(TenantContextService);

    app.use(middleware.use.bind(middleware));
    // Stands in for `HostTenantGuard`, which needs a database. Everything the
    // guards under test read is on the scope the middleware opened.
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
    signedIn = true;
    list.mockReset().mockResolvedValue({ items: [TEMPLATE], nextCursor: null });
  });

  function get(query = '') {
    return request(server).get(`/api/v1/message-templates${query}`);
  }

  it('refuses a request with no session, without reaching a query', async () => {
    signedIn = false;

    const response = await get();

    expect(response.status).toBe(401);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
    expect(list).not.toHaveBeenCalled();
  });

  it('returns the published page shape', async () => {
    const response = await get();

    expect(response.status).toBe(200);
    expect(MessageTemplatePageSchema.parse(response.body)).toMatchObject({
      items: [{ name: 'order_update', language: 'en_US', status: 'approved' }],
      nextCursor: null,
    });
  });

  it('applies the documented default page size', async () => {
    await get();

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  it('publishes the composer fields derived from the component tree', async () => {
    // Without these the composer walks Meta's tree in the browser to learn how
    // many inputs to render, and the send path cannot check arity.
    const response = await get();

    expect(MessageTemplatePageSchema.parse(response.body).items[0]).toMatchObject({
      bodyText: 'Order {{1}} ships {{2}}',
      parameterCount: 2,
      headerFormat: 'image',
      headerParameterCount: 0,
      requiresButtonParameters: false,
    });
  });

  it('passes the phone-number filter through, which is what the composer holds', async () => {
    await get(`?whatsappAccountId=${ACCOUNT_ROW_ID}`);

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ whatsappAccountId: ACCOUNT_ROW_ID }),
    );
  });

  it('passes the WABA filter through for the administrative read', async () => {
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
    ['a phone-number id that is not a uuid', '?whatsappAccountId=nope'],
    ['an empty name prefix', '?q='],
    [
      'both ids at once, which name two different scopes',
      `?whatsappAccountId=${ACCOUNT_ROW_ID}&whatsappBusinessAccountId=${WABA_ROW_ID}`,
    ],
  ])('rejects %s', async (_case, query) => {
    const response = await get(query);

    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
    expect(list).not.toHaveBeenCalled();
  });

  it('reports a phone number the tenant does not hold as bad input', async () => {
    list.mockRejectedValue(new UnknownWhatsAppAccountError());

    const response = await get(`?whatsappAccountId=${ACCOUNT_ROW_ID}`);

    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(response.body).error.details?.[0]?.path).toBe('whatsappAccountId');
  });

  it('reports a deactivated tenant as forbidden, not as a server fault', async () => {
    // The gate is `assert_tenant_active` inside TenantPrisma, so it fires on the
    // query rather than at the edge. A 500 here would page someone every time an
    // operator shut a tenant off with a session still open.
    list.mockRejectedValue(new TenantNotActiveError(TENANT_ID, 'findMany', 'MessageTemplate'));

    const response = await get();

    expect(response.status).toBe(403);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('forbidden');
  });

  it('reports a corrupted cursor as bad input rather than as a fault', async () => {
    list.mockRejectedValue(new InvalidCursorError());

    const response = await get('?cursor=nonsense');

    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(response.body).error.details?.[0]?.path).toBe('cursor');
  });
});
