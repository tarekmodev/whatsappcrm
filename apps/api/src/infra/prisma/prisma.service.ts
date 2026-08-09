import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import type { HealthCheck } from '@whatsappcrm/contracts';
import type { Logger } from 'pino';
import { withTimeout } from '../../common/with-timeout';
import type { Env } from '../../config/env.schema';
import { AppLoggerService } from '../../observability/app-logger.service';

/**
 * The application's PostgreSQL connection.
 *
 * A failed connection at boot is logged, not thrown. Crashing here would turn a
 * thirty-second database blip into a crash-loop that outlives it; reporting `down`
 * on `/api/health/ready` instead keeps the platform's health check — and the
 * uptime alert wired to it — telling the truth about why traffic is not being
 * served.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log: Logger;
  private readonly healthCheckTimeoutMs: number;
  private readonly isConfigured: boolean;

  constructor(logger: AppLoggerService, config: ConfigService<Env, true>) {
    super();

    this.log = logger.structured('PrismaService');
    this.healthCheckTimeoutMs = config.get('HEALTH_CHECK_TIMEOUT_MS', { infer: true });
    this.isConfigured = Boolean(config.get('DATABASE_URL', { infer: true }));
  }

  async onModuleInit(): Promise<void> {
    if (!this.isConfigured) {
      // Only reachable outside production — the environment schema makes
      // DATABASE_URL mandatory there.
      this.log.warn('DATABASE_URL is not set; the API will run without a database');
      return;
    }

    try {
      await this.$connect();
      this.log.info('connected to PostgreSQL');
    } catch (error) {
      this.log.error(
        { stack: error instanceof Error ? error.stack : undefined },
        'failed to connect to PostgreSQL at startup; readiness will report down until it recovers',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Measures the connection rather than trusting it — a pool can be up and unusable. */
  async ping(): Promise<HealthCheck> {
    if (!this.isConfigured) {
      return { status: 'down', detail: 'DATABASE_URL is not configured' };
    }

    try {
      await withTimeout(this.$queryRaw`SELECT 1`, this.healthCheckTimeoutMs, 'database ping');
      return { status: 'ok' };
    } catch (error) {
      this.log.warn({ reason: describe(error) }, 'database probe failed');
      return { status: 'down', detail: describe(error) };
    }
  }
}

/** Probe detail is returned to an unauthenticated caller, so it stays a short label. */
function describe(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
