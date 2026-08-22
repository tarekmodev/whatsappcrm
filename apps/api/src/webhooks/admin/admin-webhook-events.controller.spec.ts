import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AdminWebhookEventReplayResponseSchema, ApiErrorSchema } from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../../bootstrap';
import { ApiExceptionFilter } from '../../common/errors/api-exception.filter';
import { REQUEST_ID_HEADER } from '../../common/tenant-context/request-id';
import { TenantContextMiddleware } from '../../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../../common/tenant-context/tenant-context.module';
import { PlatformAdminGuard } from '../../tenancy/admin/platform-admin.guard';
import type { WebhookEventReplayOutcome } from '../webhook-events.repository';
import { AdminWebhookEventsController } from './admin-webhook-events.controller';
import { WebhookEventReplayService } from './webhook-event-replay.service';

/**
 * The HTTP contract of the replay route: who may call it, what it accepts, and
 * which status code each of the three outcomes carries. The service is stubbed —
 * what it does to the row is `webhook-event-replay.service.spec.ts` and
 * `webhook-ingestion.int-spec.ts`.
 *
 * The case worth the most here is the refusal. TAR-94 asks for a repeat replay
 * to be *rejected* rather than to quietly do nothing, so "409, not 200" is an
 * acceptance criterion rather than a preference.
 */

/** The secret half of a `PLATFORM_ADMIN_TOKEN` entry — what a caller presents. */
const TOKEN = 'a-platform-admin-token-of-at-least-32-chars';
/** What the environment holds: the same secret, named (TAR-166). */
const CONFIGURED = `ops-alice:${TOKEN}`;

const EVENT_ID = '94444444-4444-7444-8444-4444444444e1';

const REPLAYED: WebhookEventReplayOutcome = {
  kind: 'replayed',
  event: {
    id: EVENT_ID,
    provider: 'whatsapp',
    parkedError: 'unknown_phone_number_id: 15550001111',
    replayedAt: new Date('2026-08-23T09:00:00.000Z'),
  },
};

describe('the platform-admin webhook replay route', () => {
  let app: INestApplication;
  let server: Server;
  let replay: jest.Mock;

  beforeAll(async () => {
    replay = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [TenantContextModule],
      controllers: [AdminWebhookEventsController],
      providers: [
        PlatformAdminGuard,
        ApiExceptionFilter,
        { provide: WebhookEventReplayService, useValue: { replay } },
        {
          provide: ConfigService,
          // Keyed rather than a blanket return: `configureApp` reads
          // `WEB_ORIGIN` from the same service and must get its own default.
          useValue: {
            get: (key: string) => (key === 'PLATFORM_ADMIN_TOKEN' ? CONFIGURED : undefined),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    // The middleware the `AppModule` binds for every route. Bound by hand here
    // because this module is the controller under test rather than the whole
    // application — without it the error envelope has no request id to carry.
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
    replay.mockReset().mockResolvedValue(REPLAYED);
  });

  function post(id: string) {
    return request(server)
      .post(`/api/v1/admin/webhook-events/${id}/replay`)
      .set('authorization', `Bearer ${TOKEN}`);
  }

  it('answers 200 with what was reset and what it was parked for', async () => {
    const response = await post(EVENT_ID).expect(200);

    expect(AdminWebhookEventReplayResponseSchema.parse(response.body)).toEqual({
      id: EVENT_ID,
      provider: 'whatsapp',
      status: 'received',
      parkedError: 'unknown_phone_number_id: 15550001111',
      replayedAt: '2026-08-23T09:00:00.000Z',
    });

    expect(replay).toHaveBeenCalledWith(EVENT_ID);
  });

  it('reports a row that is not parked as a conflict, naming the status it is in', async () => {
    replay.mockResolvedValue({ kind: 'not-parked', status: 'processing' });

    const response = await post(EVENT_ID).expect(409);

    const { error } = ApiErrorSchema.parse(response.body);

    expect(error.code).toBe('conflict');
    // TAR-94's second criterion: a replay of something already in flight is
    // rejected rather than answering 200 for work it did not do. The status is
    // named because it decides what the operator does next.
    expect(error.message).toContain('processing');
  });

  it('refuses to replay an event that already succeeded', async () => {
    replay.mockResolvedValue({ kind: 'not-parked', status: 'processed' });

    await post(EVENT_ID).expect(409);
  });

  it('reports an unknown id as not found', async () => {
    replay.mockResolvedValue({ kind: 'not-found' });

    const response = await post(EVENT_ID).expect(404);

    expect(ApiErrorSchema.parse(response.body).error.code).toBe('not_found');
  });

  it('refuses an unauthenticated caller before the row is touched', async () => {
    const response = await request(server)
      .post(`/api/v1/admin/webhook-events/${EVENT_ID}/replay`)
      .expect(401);

    expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
    expect(replay).not.toHaveBeenCalled();
  });

  it('refuses a caller presenting the wrong token', async () => {
    const response = await request(server)
      .post(`/api/v1/admin/webhook-events/${EVENT_ID}/replay`)
      .set('authorization', 'Bearer not-the-configured-secret-but-long-enough')
      .expect(401);

    expect(ApiErrorSchema.parse(response.body).error.code).toBe('unauthenticated');
    expect(replay).not.toHaveBeenCalled();
  });

  it('rejects an id that is not a uuid rather than passing it to the query', async () => {
    const response = await post('not-a-uuid').expect(400);

    const { error } = ApiErrorSchema.parse(response.body);

    expect(error.code).toBe('validation_failed');
    expect(error.details?.map((detail) => detail.path)).toEqual(['webhookEventId']);
    expect(replay).not.toHaveBeenCalled();
  });

  it('correlates every error with the request id the caller can see', async () => {
    const response = await request(server)
      .post(`/api/v1/admin/webhook-events/${EVENT_ID}/replay`)
      .set(REQUEST_ID_HEADER, 'req_from_caller')
      .expect(401);

    expect(ApiErrorSchema.parse(response.body).error.requestId).toBe('req_from_caller');
  });
});
