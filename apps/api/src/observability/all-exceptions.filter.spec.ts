import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Module,
  NotFoundException,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
  type Type,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ApiErrorSchema } from '@whatsappcrm/contracts';
import type { Server } from 'node:http';
import request from 'supertest';
import { REQUEST_ID_HEADER } from '../common/tenant-context/request-id';
import { TenantContextMiddleware } from '../common/tenant-context/tenant-context.middleware';
import { TenantContextModule } from '../common/tenant-context/tenant-context.module';
import { validateEnv } from '../config/env';
import { ErrorTrackingService } from './error-tracking.service';
import { ObservabilityModule } from './observability.module';

const LEAKED_INTERNAL_DETAIL = 'connect ECONNREFUSED 10.0.0.7:5432';

@Controller('boom')
class BoomController {
  @Get('not-found')
  notFound(): never {
    throw new NotFoundException('Contact not found');
  }

  @Get('coded')
  coded(): never {
    throw new HttpException(
      { code: 'contact_phone_invalid', message: 'Phone number is not valid', details: [] },
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('unhandled')
  unhandled(): never {
    throw new Error(LEAKED_INTERNAL_DETAIL);
  }
}

/**
 * Built per test rather than declared once: `ConfigModule.forRoot()` reads and
 * validates `process.env` the moment it is called, so a module declared at file
 * scope would freeze the environment before a test could change it.
 */
function buildBoomModule(): Type<unknown> {
  @Module({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: validateEnv }),
      TenantContextModule,
      ObservabilityModule,
    ],
    controllers: [BoomController],
  })
  class BoomModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(TenantContextMiddleware).forRoutes('{*path}');
    }
  }

  return BoomModule;
}

describe('AllExceptionsFilter', () => {
  let app: INestApplication;
  let server: Server;
  let captureException: jest.Mock;

  beforeAll(async () => {
    captureException = jest.fn();

    const moduleRef = await Test.createTestingModule({ imports: [buildBoomModule()] })
      .overrideProvider(ErrorTrackingService)
      .useValue({ captureException, onApplicationShutdown: jest.fn() })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    captureException.mockClear();
  });

  it('answers a client error in the published envelope', async () => {
    const response = await request(server).get('/boom/not-found').expect(404);

    expect(() => ApiErrorSchema.parse(response.body)).not.toThrow();
    expect(ApiErrorSchema.parse(response.body).error).toMatchObject({
      code: 'not_found',
      message: 'Contact not found',
    });
  });

  it('correlates the envelope with the log line through the request id', async () => {
    const response = await request(server)
      .get('/boom/not-found')
      .set(REQUEST_ID_HEADER, 'req_traceable')
      .expect(404);

    expect(ApiErrorSchema.parse(response.body).error.requestId).toBe('req_traceable');
  });

  it('keeps a query string out of the envelope, because Nest puts the URL in a 404', async () => {
    const response = await request(server).get('/boom/missing?token=leaked-secret').expect(404);
    const { error } = ApiErrorSchema.parse(response.body);

    expect(error.message).not.toContain('leaked-secret');
    expect(error.message).toContain('/boom/missing');
  });

  it('lets a thrown exception carry its own stable code', async () => {
    const response = await request(server).get('/boom/coded').expect(400);

    expect(ApiErrorSchema.parse(response.body).error.code).toBe('contact_phone_invalid');
  });

  it('does not report an expected client error to the error tracker', async () => {
    await request(server).get('/boom/not-found').expect(404);

    expect(captureException).not.toHaveBeenCalled();
  });

  it('reports an unhandled exception to the error tracker, tagged with the tenant', async () => {
    await request(server).get('/boom/unhandled').expect(500);

    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0] as [
      unknown,
      { tags: Record<string, string> },
    ];

    expect(error).toBeInstanceOf(Error);
    expect(context.tags).toMatchObject({ tenantId: 'none', code: 'internal_error' });
    expect(context.tags.requestId).toEqual(expect.any(String));
  });

  it('answers an unhandled exception in the envelope, never with a stack', async () => {
    const response = await request(server).get('/boom/unhandled').expect(500);

    expect(() => ApiErrorSchema.parse(response.body)).not.toThrow();
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toContain('at ');
  });
});

describe('AllExceptionsFilter in production', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    // Required in production by the environment schema; the values are never
    // connected to in this test.
    process.env.DATABASE_URL = 'postgresql://unused/unused';
    process.env.REDIS_URL = 'redis://unused';

    const moduleRef = await Test.createTestingModule({ imports: [buildBoomModule()] })
      .overrideProvider(ErrorTrackingService)
      .useValue({ captureException: jest.fn(), onApplicationShutdown: jest.fn() })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
    process.env.NODE_ENV = 'test';
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  });

  it('never returns an internal message to the caller', async () => {
    const response = await request(server).get('/boom/unhandled').expect(500);

    expect(ApiErrorSchema.parse(response.body).error.message).not.toContain(LEAKED_INTERNAL_DETAIL);
    expect(ApiErrorSchema.parse(response.body).error.message).not.toContain('5432');
  });
});
