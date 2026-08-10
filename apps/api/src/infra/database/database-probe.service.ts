import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthCheck } from '@whatsappcrm/contracts';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import { describeFailure } from '../../common/describe-failure';
import { withTimeout } from '../../common/with-timeout';
import type { Env } from '../../config/env.schema';
import { AppLoggerService } from '../../observability/app-logger.service';

/**
 * A single connection, used only to answer "is PostgreSQL reachable" on the
 * readiness endpoint.
 *
 * Deliberately **not** the application's data access. TAR-47's schema carries no
 * `generator` block and `@prisma/client` is not a dependency: TAR-49 owns the
 * Prisma 7 client, its driver adapter, and the `TenantPrisma`/`SystemPrisma`
 * split. Building a client here to satisfy a health check would make that
 * decision on their behalf, so this uses the `pg` driver the adapter needs
 * anyway and stops there.
 *
 * **Handoff to TAR-49:** once a real client exists, probe through *its* pool
 * instead. A probe on its own connection cannot see the failure that matters
 * most in production — the application's pool being exhausted — because its own
 * connection is always free. This is the honest version of the check available
 * today, not the best one possible.
 */
@Injectable()
export class DatabaseProbeService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool | null;
  private readonly log: Logger;
  private readonly healthCheckTimeoutMs: number;

  constructor(logger: AppLoggerService, config: ConfigService<Env, true>) {
    this.log = logger.structured('DatabaseProbe');
    this.healthCheckTimeoutMs = config.get('HEALTH_CHECK_TIMEOUT_MS', { infer: true });

    const connectionString = config.get('DATABASE_URL', { infer: true });

    this.pool = connectionString
      ? new Pool({
          connectionString,
          // One connection is all a probe needs, and every connection here is one
          // the application cannot have. Pods x instances x pool size is a real
          // budget against a managed Postgres.
          max: 1,
          connectionTimeoutMillis: this.healthCheckTimeoutMs,
        })
      : null;
  }

  onModuleInit(): void {
    if (!this.pool) {
      // Only reachable outside production — the environment schema makes
      // DATABASE_URL mandatory there.
      this.log.warn('DATABASE_URL is not set; readiness will report the database as down');
      return;
    }

    // `pg` emits on a pooled client dying in the background. Unhandled, that
    // event is an uncaught exception that takes the process down.
    this.pool.on('error', (error: Error) => {
      this.log.warn({ reason: describeFailure(error) }, 'idle database connection error');
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  /** Measures the connection rather than trusting it — a pool can be up and unusable. */
  async ping(): Promise<HealthCheck> {
    if (!this.pool) {
      return { status: 'down', detail: 'DATABASE_URL is not configured' };
    }

    try {
      await withTimeout(this.pool.query('SELECT 1'), this.healthCheckTimeoutMs, 'database ping');
      return { status: 'ok' };
    } catch (error) {
      this.log.warn({ reason: describeFailure(error) }, 'database probe failed');
      return { status: 'down', detail: describeFailure(error) };
    }
  }
}
