import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthCheck, HealthResponse, HealthStatus } from '@whatsappcrm/contracts';
import type { Env } from '../config/env.schema';
import { DatabaseProbeService } from '../infra/database/database-probe.service';
import { RedisService } from '../infra/redis/redis.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly database: DatabaseProbeService,
    private readonly redis: RedisService,
  ) {}

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
    const [database, queue] = await Promise.all([this.database.ping(), this.redis.ping()]);
    const checks = { database, queue };

    return this.envelope(aggregate(checks), checks);
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
