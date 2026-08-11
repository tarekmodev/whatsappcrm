import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { WebhookIngestService } from './webhook-ingest.service';
import { WebhookSignatureInvalidError } from './webhook.errors';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';

const CHALLENGE = '1158201444';

/**
 * The route contract Meta is held to, exercised through a real HTTP server.
 *
 * `WebhookIngestService` is the boundary and is stubbed: what the signature
 * check does is covered in its own spec, and what matters here is the shape of
 * the answer — path, status, content type, and the fact that a refusal echoes
 * nothing.
 */
describe('the WhatsApp webhook route', () => {
  let app: INestApplication;
  let server: Server;
  let verifyHandshake: jest.Mock;
  let ingestWhatsApp: jest.Mock;

  beforeEach(async () => {
    verifyHandshake = jest.fn().mockReturnValue(CHALLENGE);
    ingestWhatsApp = jest.fn().mockResolvedValue('stored');

    const moduleRef = await Test.createTestingModule({
      controllers: [WhatsAppWebhookController],
      providers: [
        TenantContextService,
        ApiExceptionFilter,
        { provide: WebhookIngestService, useValue: { verifyHandshake, ingestWhatsApp } },
        // `configureApp` reads the CORS origin from it. Stubbed rather than
        // loading the real `ConfigModule`, so this suite needs no environment.
        { provide: ConfigService, useValue: { get: (): undefined => undefined } },
      ],
    }).compile();

    // The same option `main.ts` uses. Without it `request.rawBody` is undefined
    // and every genuine delivery is refused — which is precisely the failure
    // this assertion is here to catch if someone removes it from bootstrap.
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET — the verification handshake', () => {
    /**
     * Unversioned on purpose. This URL is registered once inside Meta's
     * dashboard, so `/api/v1/...` would tie a third party's configuration to our
     * versioning scheme.
     */
    it('lives at /api/webhooks/whatsapp, outside the version prefix', async () => {
      await request(server)
        .get('/api/webhooks/whatsapp')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token', 'hub.challenge': CHALLENGE })
        .expect(200);

      await request(server).get('/api/v1/webhooks/whatsapp').expect(404);
    });

    it('echoes the challenge verbatim as text, which is what Meta compares', async () => {
      const response = await request(server)
        .get('/api/webhooks/whatsapp')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token', 'hub.challenge': CHALLENGE })
        .expect(200);

      expect(response.text).toBe(CHALLENGE);
      expect(response.headers['content-type']).toContain('text/plain');
    });

    it('answers 403 and echoes nothing when the token does not match', async () => {
      verifyHandshake.mockImplementation(() => {
        throw new WebhookSignatureInvalidError();
      });

      const response = await request(server)
        .get('/api/webhooks/whatsapp')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': CHALLENGE })
        .expect(403);

      expect(response.text).not.toContain(CHALLENGE);
    });

    it('rejects a handshake that is not a subscribe', async () => {
      await request(server)
        .get('/api/webhooks/whatsapp')
        .query({
          'hub.mode': 'unsubscribe',
          'hub.verify_token': 'token',
          'hub.challenge': CHALLENGE,
        })
        .expect(400);

      expect(verifyHandshake).not.toHaveBeenCalled();
    });
  });

  describe('POST — an inbound delivery', () => {
    const body = { object: 'whatsapp_business_account', entry: [] };

    it('answers 200 as soon as the payload is durable', async () => {
      await request(server)
        .post('/api/webhooks/whatsapp')
        .set('x-hub-signature-256', 'sha256=deadbeef')
        .send(body)
        .expect(200);
    });

    /** Signing over a re-serialised body cannot work, so the raw bytes must reach the service. */
    it('hands the service the exact bytes that were signed', async () => {
      const raw = JSON.stringify(body);

      await request(server)
        .post('/api/webhooks/whatsapp')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', 'sha256=deadbeef')
        .send(raw)
        .expect(200);

      const [rawBody, header] = ingestWhatsApp.mock.calls[0] as [Buffer | undefined, unknown];

      expect(Buffer.isBuffer(rawBody)).toBe(true);
      expect(rawBody?.toString('utf8')).toBe(raw);
      expect(header).toBe('sha256=deadbeef');
    });

    it('answers 401 with the published error code when the signature is refused', async () => {
      ingestWhatsApp.mockRejectedValue(new WebhookSignatureInvalidError());

      const response = await request(server)
        .post('/api/webhooks/whatsapp')
        .set('x-hub-signature-256', 'sha256=00')
        .send(body)
        .expect(401);

      const { error } = response.body as { error: { code: string } };

      expect(error.code).toBe('webhook_signature_invalid');
    });

    /** A refusal must not tell an anonymous caller whether the secret is wrong or absent. */
    it('never explains why it refused', async () => {
      ingestWhatsApp.mockRejectedValue(new WebhookSignatureInvalidError());

      const response = await request(server)
        .post('/api/webhooks/whatsapp')
        .set('x-hub-signature-256', 'sha256=00')
        .send(body)
        .expect(401);

      expect(JSON.stringify(response.body)).not.toMatch(/secret|configur/i);
    });

    it('answers 200 for a duplicate Meta retried', async () => {
      ingestWhatsApp.mockResolvedValue('duplicate');

      await request(server)
        .post('/api/webhooks/whatsapp')
        .set('x-hub-signature-256', 'sha256=deadbeef')
        .send(body)
        .expect(200);
    });
  });
});
