import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import type { HealthResponse } from '@whatsappcrm/contracts';
import { HealthService } from './health.service';

/**
 * `VERSION_NEUTRAL` keeps this on `/api/health` now that URI versioning is
 * enabled (TAR-39: "`/api/health` stays unversioned"). The uptime monitor and
 * the container `HEALTHCHECK` point at a fixed path, and moving it to
 * `/api/v1/health` on the next API version would silently break both.
 */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** `GET /api/health` — unauthenticated by design; the uptime monitor calls it. */
  @Get()
  check(): HealthResponse {
    return this.health.check();
  }
}
