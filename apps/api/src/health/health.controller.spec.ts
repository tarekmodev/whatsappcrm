import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthResponseSchema } from '@whatsappcrm/contracts';
import request from 'supertest';
import { AppModule } from '../app.module';
import { configureApp } from '../bootstrap';
import { REQUEST_ID_HEADER } from '../common/tenant-context/tenant-context.middleware';

describe('GET /api/health', () => {
  let app: INestApplication;
  // `getHttpServer()` is typed `any`; narrowing once here keeps the type-aware
  // lint rules meaningful for the rest of the file.
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a payload matching the published contract', async () => {
    const response = await request(server).get('/api/health').expect(200);

    // `parse` throws, and so fails the test, the moment the response drifts
    // from the published schema.
    const health = HealthResponseSchema.parse(response.body);

    expect(health.status).toBe('ok');
  });

  it('stamps a request id, proving the tenant context middleware ran', async () => {
    const response = await request(server).get('/api/health').expect(200);

    expect(response.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
  });

  it('echoes a caller-supplied request id so traces span services', async () => {
    const response = await request(server)
      .get('/api/health')
      .set(REQUEST_ID_HEADER, 'req_from_caller')
      .expect(200);

    expect(response.headers[REQUEST_ID_HEADER]).toBe('req_from_caller');
  });
});
