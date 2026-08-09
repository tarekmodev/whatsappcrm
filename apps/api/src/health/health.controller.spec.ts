import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthResponseSchema } from '@whatsappcrm/contracts';
import request from 'supertest';
import { AppModule } from '../app.module';
import { configureApp } from '../bootstrap';
import { REQUEST_ID_HEADER } from '../common/tenant-context/tenant-context.middleware';

describe('GET /api/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a payload matching the published contract', async () => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200);

    expect(() => HealthResponseSchema.parse(response.body)).not.toThrow();
    expect(response.body.status).toBe('ok');
  });

  it('stamps a request id, proving the tenant context middleware ran', async () => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200);

    expect(response.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
  });

  it('echoes a caller-supplied request id so traces span services', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/health')
      .set(REQUEST_ID_HEADER, 'req_from_caller')
      .expect(200);

    expect(response.headers[REQUEST_ID_HEADER]).toBe('req_from_caller');
  });
});
