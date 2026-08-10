import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthCheck, HealthResponse, HealthStatus } from '@whatsappcrm/contracts';
import type { Logger } from 'pino';
import { describeFailure } from '../common/describe-failure';
import { withTimeout } from '../common/with-timeout';
import type { Env } from '../config/env.schema';
import { RedisService } from '../infra/redis/redis.service';
import { AppLoggerService } from '../observability/app-logger.service';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';

@Injectable()
export class HealthService {
  private readonly log: Logger;
  private readonly healthCheckTimeoutMs: number;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly redis: RedisService,
    logger: AppLoggerService,
    @Inject(SYSTEM_PRISMA) private readonly prisma: SystemPrisma,
  ) {
    this.log = logger.structured('HealthService');
    this.healthCheckTimeoutMs = config.get('HEALTH_CHECK_TIMEOUT_MS', { infer: true });
  }

  /**
   * Liveness: is this process running at all.
   *
   * Deliberately probes nothing. A liveness check that fails when the database
   * blinks tells the platform to restart a perfectly healthy process, which turns
   * a dependency outage into a restart storm on top of it.
   */
  liveness(): HealthResponse {
    return this.envelope('ok', {});
  }

  /**
   * Readiness: can this process actually serve traffic.
   *
   * Both probes run concurrently and both are bounded, so the answer arrives in
   * roughly one probe's time even when a dependency is hanging.
   */
  async readiness(): Promise<HealthResponse> {
    const [database, queue] = await Promise.all([this.probeDatabase(), this.redis.ping()]);
    const checks = { database, queue };

    return this.envelope(aggregate(checks), checks);
  }

  /**
   * Probes through `SystemPrisma` — a real pool the application uses, rather than
   * a connection opened just for the health check. Measuring a pool nobody else
   * touches cannot detect the failure that matters most in production, which is
   * the application's pool being exhausted.
   *
   * `SystemPrisma` rather than `TenantPrisma` because `TenantPrisma` is
   * tenant-scoped by extension and a probe has no tenant. This is not a sixth
   * cross-tenant call site in the sense TAR-39 restricts: `SELECT 1` reads no
   * table and returns no row.
   */
  private async probeDatabase(): Promise<HealthCheck> {
    try {
      await withTimeout(
        this.prisma.$queryRaw`SELECT 1`,
        this.healthCheckTimeoutMs,
        'database ping',
      );
      return { status: 'ok' };
    } catch (error) {
      this.log.warn({ reason: describeFailure(error) }, 'database probe failed');
      return { status: 'down', detail: describeFailure(error) };
    }
  }

  private envelope(status: HealthStatus, checks: HealthResponse['checks']): HealthResponse {
    return {
      status,
      version: this.config.get('APP_VERSION', { infer: true }),
      uptimeSeconds: Math.floor(process.uptime()),
      checks,
    };
  }
}

/** The worst check wins: a service missing either dependency cannot serve a request. */
function aggregate(checks: Record<string, HealthCheck>): HealthStatus {
  const statuses = Object.values(checks).map((check) => check.status);

  if (statuses.includes('down')) {
    return 'down';
  }

  return statuses.includes('degraded') ? 'degraded' : 'ok';
}
