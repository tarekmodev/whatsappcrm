import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { HealthResponse } from '@whatsappcrm/contracts';
import type { Response } from 'express';
import { HealthService } from './health.service';

@Controller('health')
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
