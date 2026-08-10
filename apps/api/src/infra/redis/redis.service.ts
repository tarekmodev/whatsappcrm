import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthCheck } from '@whatsappcrm/contracts';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { describeFailure } from '../../common/describe-failure';
import { withTimeout } from '../../common/with-timeout';
import type { Env } from '../../config/env.schema';
import { AppLoggerService } from '../../observability/app-logger.service';

const CONNECT_TIMEOUT_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 5_000;
const RECONNECT_DELAY_STEP_MS = 200;

/**
 * The Redis connection the queue and the realtime gateway are built on.
 *
 * `ioredis` is the client BullMQ itself uses, so the story that adds the queue
 * inherits this connection rather than opening a second one — which matters
 * because pods x connections is a real budget on a managed Key Value instance.
 *
 * Redis is a latency dependency here, not a durability one: per ADR 0001 the
 * webhook path persists to PostgreSQL before it enqueues, so Redis being down
 * makes the product late, not lossy.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis | null;
  private readonly log: Logger;
  private readonly healthCheckTimeoutMs: number;
  /** ioredis retries on a timer, so an outage would otherwise emit a line every retry. */
  private hasReportedDisconnection = false;

  constructor(logger: AppLoggerService, config: ConfigService<Env, true>) {
    this.log = logger.structured('RedisService');
    this.healthCheckTimeoutMs = config.get('HEALTH_CHECK_TIMEOUT_MS', { infer: true });

    const url = config.get('REDIS_URL', { infer: true });

    this.client = url
      ? new Redis(url, {
          // Connecting is this service's own decision, made in `onModuleInit`, so a
          // constructor never performs I/O.
          lazyConnect: true,
          connectTimeout: CONNECT_TIMEOUT_MS,
          // Fail a command against a dead connection immediately instead of
          // buffering it: a queued probe reports nothing, and a queue that grows
          // while Redis is down is just deferred memory pressure.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          retryStrategy: (attempt) =>
            Math.min(attempt * RECONNECT_DELAY_STEP_MS, MAX_RECONNECT_DELAY_MS),
        })
      : null;
  }

  /**
   * The live client. Throws when Redis is unconfigured, so a queue producer fails
   * loudly at the call site rather than silently dropping work.
   */
  get connection(): Redis {
    if (!this.client) {
      throw new Error('REDIS_URL is not configured: no Redis connection is available');
    }

    return this.client;
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) {
      // Only reachable outside production — the environment schema makes
      // REDIS_URL mandatory there.
      this.log.warn('REDIS_URL is not set; the API will run without a queue connection');
      return;
    }

    // `retryStrategy` keeps trying in the background, so a failure here is a
    // reported condition rather than a terminal one. One line per outage and one
    // per recovery — an alert wants a transition, not a metronome.
    this.client.on('error', (error: Error) => {
      if (this.hasReportedDisconnection) {
        return;
      }

      this.hasReportedDisconnection = true;
      this.log.error(
        { reason: describeFailure(error) },
        'lost the Redis connection; retrying in the background',
      );
    });

    this.client.on('ready', () => {
      if (!this.hasReportedDisconnection) {
        return;
      }

      this.hasReportedDisconnection = false;
      this.log.info('Redis connection recovered');
    });

    try {
      await this.client.connect();
      this.log.info('connected to Redis');
    } catch (error) {
      this.log.error(
        { stack: error instanceof Error ? error.stack : undefined },
        'failed to connect to Redis at startup; readiness will report down until it recovers',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) {
      return;
    }

    // `quit` drains in flight commands; `disconnect` would drop them.
    await this.client.quit().catch(() => this.client?.disconnect());
  }

  async ping(): Promise<HealthCheck> {
    if (!this.client) {
      return { status: 'down', detail: 'REDIS_URL is not configured' };
    }

    if (this.client.status !== 'ready') {
      return { status: 'down', detail: `connection is ${this.client.status}` };
    }

    try {
      await withTimeout(this.client.ping(), this.healthCheckTimeoutMs, 'queue ping');
      return { status: 'ok' };
    } catch (error) {
      this.log.warn({ reason: describeFailure(error) }, 'queue probe failed');
      return { status: 'down', detail: describeFailure(error) };
    }
  }
}
