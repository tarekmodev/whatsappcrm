import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthResponse } from '@whatsappcrm/contracts';

@Injectable()
export class HealthService {
  constructor(private readonly config: ConfigService) {}

  check(): HealthResponse {
    // TAR-41 adds `database` and `queue` probes here and downgrades `status` to
    // `degraded`/`down` accordingly. Until those services exist this endpoint
    // reports process liveness only — it must never claim dependency health it
    // has not actually measured, or the uptime alert becomes a lie.
    const checks: HealthResponse['checks'] = {};

    return {
      status: 'ok',
      version: this.config.get<string>('APP_VERSION') ?? '0.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
      checks,
    };
  }
}
