import { Body, Controller, HttpCode, Post, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { KNOWLEDGE_DOCUMENT_LIMITS } from '@whatsappcrm/contracts';
import type { Server } from 'node:http';
import request from 'supertest';
import { configureApp } from './bootstrap';

/**
 * The JSON body limit, which is a published cap rather than an implementation
 * detail.
 *
 * A knowledge document may be 256 KiB — the contract says so and the console
 * validates against it — but Express reads at most 100 KB by default and Nest
 * does not raise it. So an admin pasting a long policy document had the request
 * refused by the parser before any handler, any guard or any validation saw it,
 * and the number written down was one nothing could reach.
 *
 * Tested through `configureApp` rather than through the knowledge-base
 * controller on purpose: the limit belongs to every route, and the one thing
 * that must not happen is a body parser configured only where somebody
 * remembered.
 */

@Controller({ path: 'echo-size', version: '1' })
class EchoSizeController {
  @Post()
  @HttpCode(200)
  measure(@Body() body: { content?: string }): { length: number } {
    return { length: body.content?.length ?? 0 };
  }
}

describe('the JSON body limit', () => {
  let app: INestApplication;
  let server: Server;

  /** A body of exactly `bytes` ASCII characters in `content`, envelope aside. */
  function payload(bytes: number): { content: string } {
    return { content: 'a'.repeat(bytes) };
  }

  beforeAll(async () => {
    // One controller and the one provider `configureApp` reads, rather than
    // `AppModule`: this is about the parser in front of every route, and an app
    // carrying the global auth guard would answer 401 before the body mattered.
    const moduleRef = await Test.createTestingModule({
      controllers: [EchoSizeController],
      providers: [{ provide: ConfigService, useValue: { get: () => 'http://localhost:3000' } }],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a knowledge document at exactly the published cap', async () => {
    // The regression. Under Express's default this is a 413 the admin sees as
    // "we could not save that", with nothing naming a size.
    const content = payload(KNOWLEDGE_DOCUMENT_LIMITS.contentBytes);

    const response = await request(server).post('/api/v1/echo-size').send(content).expect(200);

    expect((response.body as { length: number }).length).toBe(
      KNOWLEDGE_DOCUMENT_LIMITS.contentBytes,
    );
  });

  it('accepts more than the old 100 KB default, which is the bound that was wrong', async () => {
    await request(server).post('/api/v1/echo-size').send(payload(150_000)).expect(200);
  });

  it('still refuses a body no honest client sends', async () => {
    // The limit is raised, not removed: an unbounded parser is a way to spend a
    // server's memory from the outside.
    const response = await request(server)
      .post('/api/v1/echo-size')
      .send(payload(KNOWLEDGE_DOCUMENT_LIMITS.contentBytes * 3))
      .expect(413);

    // Nest's own shape, not the platform error envelope — a body-parser failure
    // happens before the route, so the global filter never sees it and there is
    // no `error.code` for a client to read. Documented rather than fixed here:
    // raising the limit is what takes a knowledge document off this path, and
    // teaching the filter to map it is a change to every route's error handling.
    expect(response.body).toMatchObject({ statusCode: 413 });
    expect(response.body).not.toHaveProperty('error.code');
  });
});
