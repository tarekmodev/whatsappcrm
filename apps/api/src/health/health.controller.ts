import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { HealthResponse } from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { HealthService } from './health.service';

/**
 * `VERSION_NEUTRAL` keeps these on `/api/health` now that URI versioning is
 * enabled (TAR-39: "`/api/health` stays unversioned"). The uptime monitor, the
 * container `HEALTHCHECK` and Render's own health check all point at a fixed
 * path, and moving them to `/api/v1/health` on the next API version would
 * silently break all three.
 */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** `GET /api/health` — liveness. Unauthenticated by design; the platform calls it. */
  @Get()
  check(): HealthResponse {
    return this.health.liveness();
  }

  /**
   * `GET /api/health/ready` — readiness, reporting database and queue connectivity.
   *
   * This is the path Render's health check and the external uptime monitor both
   * point at. It answers `503` when a dependency is down but still returns the
   * full body, so the alert says *which* dependency rather than only that
   * something is wrong.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const body = await this.health.readiness();

    response.status(body.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return body;
  }
}
