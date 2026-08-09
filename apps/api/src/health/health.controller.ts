import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@whatsappcrm/contracts';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** `GET /api/health` — unauthenticated by design; the uptime monitor calls it. */
  @Get()
  check(): HealthResponse {
    return this.health.check();
  }
}
