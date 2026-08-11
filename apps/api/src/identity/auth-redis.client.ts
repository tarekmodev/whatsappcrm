import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/**
 * The one Redis connection the auth layer uses, and the one place a Redis
 * failure is turned into "carry on without it".
 *
 * Extracted from `SessionCacheService` when TAR-59 added a second consumer: the
 * per-address failure window. Two `Redis` instances against the same server
 * from one process is two sockets, two error handlers and two shutdown paths to
 * keep in step, and the second copy of `run()` would be the place the retry and
 * timeout settings quietly drift apart.
 *
 * **Nothing here throws.** Every caller in this module degrades to something
 * correct without Redis — the session cache falls back to Postgres, the failure
 * window falls back to the durable per-account counter — so a Redis blip must
 * cost latency and never authentication. `run()` returning `null` is how a
 * caller is told to take that path, which is why the type is `T | null` rather
 * than a thrown error nobody could usefully catch.
 */

/** Keeps auth keys clear of BullMQ's, which use their own prefix. */
export const AUTH_KEY_PREFIX = 'wac:auth';

/**
 * Cap on how long a command may wait.
 *
 * Every authenticated request goes through this, so an unresponsive Redis must
 * degrade quickly rather than parking commands in ioredis's offline queue —
 * which would turn "the cache is slow" into "the API is down". Tight, because
 * the fallback is one indexed read.
 */
const COMMAND_TIMEOUT_MS = 500;

@Injectable()
export class AuthRedisClient implements OnApplicationShutdown {
  private readonly logger = new Logger(AuthRedisClient.name);
  private readonly url: string | null;
  private client: Redis | null = null;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');

    this.url = url === undefined || url.length === 0 ? null : url;

    if (this.url === null) {
      this.logger.warn(
        'REDIS_URL is not set: session lookups read Postgres and the per-address login ' +
          'failure window is disabled. Correct, and one extra query per authenticated request.',
      );
    }
  }

  /**
   * Runs one operation, or reports that it could not.
   *
   * The single place failure is swallowed, so no call site has to remember to —
   * and so "Redis is down" is one `warn` per operation naming what was
   * attempted rather than a stack trace that looks like an outage.
   */
  async run<T>(operation: string, work: (client: Redis) => Promise<T>): Promise<T | null> {
    const client = this.connect();

    if (client === null) {
      return null;
    }

    try {
      return await work(client);
    } catch (error: unknown) {
      this.logger.warn(`Auth Redis ${operation} failed; degrading: ${describe(error)}`);
      return null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client === null) {
      return;
    }

    // `quit` drains; `disconnect` tears down a reconnect timer a `quit` against
    // an unreachable Redis would leave armed, which would hold the process past
    // its termination grace period during exactly the incident where a clean
    // exit matters most.
    await this.client.quit().catch(() => undefined);
    this.client.disconnect();
    this.client = null;
  }

  private connect(): Redis | null {
    if (this.url === null) {
      return null;
    }

    this.client ??= this.open(this.url);

    return this.client;
  }

  private open(url: string): Redis {
    const client = new Redis(url, {
      // Nothing connects until the first command, so a process that never
      // resolves a session never opens a socket.
      lazyConnect: true,
      commandTimeout: COMMAND_TIMEOUT_MS,
      // One retry, then fail to the degraded path. The default keeps retrying
      // inside a single command, which is latency spent on a fallback that is
      // already correct.
      maxRetriesPerRequest: 1,
    });

    // Without a listener Node treats a connection `error` as unhandled and
    // takes the process down — which would turn a Redis restart into an API
    // outage, the opposite of what degrading gracefully is for.
    client.on('error', (error: Error) => {
      this.logger.warn(`Auth Redis connection reported: ${error.message}`);
    });

    return client;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
