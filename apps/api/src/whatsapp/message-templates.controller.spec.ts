import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ApiErrorSchema, MessageTemplatePageSchema } from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { InvalidCursorError, MessageTemplateQueryService } from './message-template-query.service';
import { MessageTemplatesController } from './message-templates.controller';

/**
 * The HTTP contract of `GET /api/v1/message-templates`.
 *
 * The first assertion is the load-bearing one until TAR-35 lands: with no
 * tenant resolved, the endpoint answers 401 and never reaches a query. There is
 * no path from an unauthenticated request to a row.
 */

const WABA_ROW_ID = '60444444-4444-7444-8444-444444444401';
const TENANT_ID = '50444444-4444-7444-8444-4444444444c1';
const TIMESTAMP = new Date('2026-08-10T09:00:00.000Z');

const TEMPLATE = {
  id: '80444444-4444-7444-8444-444444444401',
  whatsappBusinessAccountId: WABA_ROW_ID,
  name: 'order_update',
  language: 'en_US',
  category: 'UTILITY',
  status: 'approved' as const,
  components: [{ type: 'BODY', text: 'Order {{1}}' }],
  providerTemplateId: '1001',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

describe('GET /api/v1/message-templates', () => {
  let app: INestApplication;
  let server: Server;
  let list: jest.Mock;
  let tenantId: string | null;

  beforeAll(async () => {
    list = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [MessageTemplatesController],
      providers: [
        ApiExceptionFilter,
        { provide: MessageTemplateQueryService, useValue: { list } },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    // Stands in for TAR-35's `AuthGuard`, which is what will eventually put a
    // tenant on the scope the middleware opens. Spied on the prototype rather
    // than swapping the provider, because the middleware and the error filter
    // both need the real service.
    jest
      .spyOn(TenantContextService.prototype, 'tenantId', 'get')
      .mockImplementation(() => tenantId);

    app = moduleRef.createNestApplication();

    const middleware = app.get(TenantContextMiddleware);
    app.use(middleware.use.bind(middleware));

    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    tenantId = TENANT_ID;
    list.mockReset().mockResolvedValue({ items: [TEMPLATE], nextCursor: null });
  });

  function get(query = '') {
    return request(server).get(`/api/v1/message-templates${query}`);
  }

  it('refuses a request with no tenant resolved, without reaching a query', async () => {
    tenantId = null;

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

  it('passes the WABA filter through', async () => {
    await get(`?whatsappBusinessAccountId=${WABA_ROW_ID}`);

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ whatsappBusinessAccountId: WABA_ROW_ID }),
    );
  });

  it.each([
    ['a limit above the cap', '?limit=1000'],
    ['a limit below one', '?limit=0'],
    ['a WABA id that is not a uuid', '?whatsappBusinessAccountId=nope'],
  ])('rejects %s', async (_case, query) => {
    const response = await get(query);

    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('validation_failed');
    expect(list).not.toHaveBeenCalled();
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
