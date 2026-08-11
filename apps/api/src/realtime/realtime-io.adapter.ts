import { Logger, type INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { Env } from '../config/env.schema';
import { REALTIME_PATH } from './realtime.constants';

/**
 * How the Socket.IO server is built, and the two things a decorator could not
 * express.
 *
 * ## CORS from configuration
 *
 * `@WebSocketGateway({ cors })` is evaluated at class-definition time, before
 * `ConfigService` exists, so the origin would have to be a literal. It is read
 * here from the same `WEB_ORIGIN` that `configureApp` gives the HTTP server, so
 * the two allow-lists cannot drift — a socket the console may not open is a
 * feature that silently does not work, and a wildcard here would be an origin
 * allow-list with nothing in it.
 *
 * ## The Redis adapter, which is a correctness fix rather than an optimisation
 *
 * Domain events fan out **in process**. Sockets do not: a customer's message is
 * ingested by whichever replica Meta's webhook reached, and the agent watching
 * that conversation is connected to whichever replica the load balancer chose.
 * With the default in-memory adapter those are the same replica only by luck, so
 * on more than one instance most events would reach nobody — a failure that
 * looks exactly like "realtime is flaky" and has no error anywhere.
 * `@socket.io/redis-adapter` publishes each room emit over Redis pub/sub so
 * every replica delivers to its own sockets.
 *
 * Two connections, because a Redis client in subscriber mode may not issue
 * commands — that is Redis's rule, not a choice — and both are separate from
 * `AuthRedisClient` and from BullMQ's for the same reason those two are separate
 * from each other: one socket per concern, with its own error handler and its
 * own shutdown.
 *
 * ### Without Redis it degrades loudly rather than silently
 *
 * `REDIS_URL` is optional in development and required in production
 * (`env.schema.ts`), so a developer on one process gets the in-memory adapter
 * and a working inbox. The warning names the consequence, because this is the
 * one place where "it worked on my machine" is a deployment-shaped bug rather
 * than a slogan.
 */
export class RealtimeIoAdapter extends IoAdapter {
  private static readonly logger = new Logger(RealtimeIoAdapter.name);

  private constructor(
    app: INestApplicationContext,
    private readonly corsOrigin: string,
    private readonly redis: RedisAdapterConnections | null,
  ) {
    super(app);
  }

  /**
   * Builds the adapter, connecting to Redis first so a misconfigured URL fails
   * the boot rather than the first message. A connection failure is not fatal:
   * the process still serves HTTP, and one replica's sockets still work.
   */
  static async create(app: INestApplicationContext): Promise<RealtimeIoAdapter> {
    const config = app.get<ConfigService<Env, true>>(ConfigService);
    const corsOrigin = config.get('WEB_ORIGIN', { infer: true });
    const url = config.get('REDIS_URL', { infer: true });

    if (url === undefined || url.length === 0) {
      RealtimeIoAdapter.logger.warn(
        'REDIS_URL is not set: the realtime gateway uses the in-memory Socket.IO adapter. ' +
          'Correct on a single process, and silently lossy on more than one — an event emitted ' +
          'on one replica reaches only the sockets connected to that replica.',
      );

      return new RealtimeIoAdapter(app, corsOrigin, null);
    }

    return new RealtimeIoAdapter(app, corsOrigin, await connect(url));
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      path: REALTIME_PATH,
      cors: { origin: this.corsOrigin, credentials: true },
    }) as Server;

    if (this.redis !== null) {
      server.adapter(createAdapter(this.redis.publisher, this.redis.subscriber));
    }

    return server;
  }

  /**
   * Closes the pub/sub pair with the server.
   *
   * `quit` then `disconnect`, on `AuthRedisClient`'s reasoning: `quit` drains,
   * and `disconnect` tears down a reconnect timer that a `quit` against an
   * unreachable Redis would leave armed and holding the process past its
   * termination grace period.
   */
  override async close(server: Server): Promise<void> {
    await super.close(server);

    if (this.redis === null) {
      return;
    }

    for (const client of [this.redis.publisher, this.redis.subscriber]) {
      await client.quit().catch(() => undefined);
      client.disconnect();
    }
  }
}

interface RedisAdapterConnections {
  readonly publisher: Redis;
  readonly subscriber: Redis;
}

async function connect(url: string): Promise<RedisAdapterConnections | null> {
  const publisher = open(url, 'publisher');
  const subscriber = publisher.duplicate();

  attachErrorLogging(subscriber, 'subscriber');

  try {
    await Promise.all([publisher.connect(), subscriber.connect()]);
    return { publisher, subscriber };
  } catch (error: unknown) {
    Logger.warn(
      `Realtime Redis adapter could not connect; falling back to the in-memory adapter: ${describe(error)}`,
      RealtimeIoAdapter.name,
    );

    publisher.disconnect();
    subscriber.disconnect();

    return null;
  }
}

function open(url: string, role: string): Redis {
  // No `commandTimeout`: the subscriber holds a long-lived subscription, and a
  // command timeout on a connection whose job is to wait is a disconnect on a
  // timer. `lazyConnect` so `connect()` above is what decides when the socket
  // opens, and so a failure surfaces there rather than as an unhandled event.
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });

  attachErrorLogging(client, role);

  return client;
}

/**
 * Without a listener Node treats a connection `error` as unhandled and takes the
 * process down — which would turn a Redis restart into an API outage.
 */
function attachErrorLogging(client: Redis, role: string): void {
  client.on('error', (error: Error) => {
    Logger.warn(`Realtime Redis ${role} reported: ${error.message}`, RealtimeIoAdapter.name);
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
