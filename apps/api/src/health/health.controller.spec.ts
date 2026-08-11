import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthResponseSchema } from '@whatsappcrm/contracts';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../app.module';
import { configureApp } from '../bootstrap';
import { REQUEST_ID_HEADER } from '../common/tenant-context/tenant-context.middleware';

// The suite runs with no DATABASE_URL and no REDIS_URL (jest.setup.js), which is
// exactly the "dependencies unreachable" case readiness has to report honestly.
describe('health endpoints', () => {
  let app: INestApplication;
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

  describe('GET /api/health', () => {
    it('returns a payload matching the published contract', async () => {
      const response = await request(server).get('/api/health').expect(200);

      expect(() => HealthResponseSchema.parse(response.body)).not.toThrow();
      expect(HealthResponseSchema.parse(response.body).status).toBe('ok');
    });

    it('stays up when its dependencies are not, because it is a liveness probe', async () => {
      const response = await request(server).get('/api/health').expect(200);

      expect(HealthResponseSchema.parse(response.body).checks).toEqual({});
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

  describe('GET /api/health/ready', () => {
    it('answers 503 while a dependency is unreachable', async () => {
      const response = await request(server).get('/api/health/ready').expect(503);

      expect(HealthResponseSchema.parse(response.body).status).toBe('down');
    });

    it('names which dependency is down rather than only that something is', async () => {
      const response = await request(server).get('/api/health/ready').expect(503);

      const { checks } = HealthResponseSchema.parse(response.body);

      expect(checks.database?.status).toBe('down');
      expect(checks.queue?.status).toBe('down');
      // The detail is what turns a page into a diagnosis.
      expect(typeof checks.database?.detail).toBe('string');
      expect(typeof checks.queue?.detail).toBe('string');
    });
  });
});
