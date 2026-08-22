import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UseFilters,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { PlatformRoute } from '../common/request-pipeline/route-access';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingWebhookRefusedError } from './billing.errors';

/**
 * The payment provider's webhook endpoint. Public, signature-verified, and never
 * cookie-authenticated — the same posture as Meta's, and mirroring
 * `whatsapp-webhook.controller.ts` deliberately rather than inventing a second
 * shape for the same problem.
 *
 * **`VERSION_NEUTRAL`, so the path is `/api/webhooks/billing`.** The URI version
 * prefix is a contract with *our* clients; this URL is registered once inside
 * the provider's dashboard and changing it means an outage plus a manual
 * reconfiguration, so it is deliberately outside the versioning scheme.
 *
 * `@PlatformRoute()` takes it out of the global pipeline. The provider posts to
 * the platform host with no cookie, so tenant resolution and session lookup have
 * nothing to work with — the tenant is derived from metadata *inside* the signed
 * payload, after the signature has been checked, by the worker. Authentication
 * here **is** the signature over the raw body, and a guard would have to
 * duplicate it or run before the raw body is available.
 *
 * ## Why it answers 200 and does nothing else
 *
 * The provider's timeout is 10 seconds and it recommends answering within 2 by
 * queueing. Anything done on this path would be done again on every retry, under
 * exactly the load that made it slow — and **ten consecutive non-2xx responses
 * disable the endpoint**, which is the highest-severity failure this subsystem
 * has. So the handler verifies, stores, and returns.
 *
 * The response body is empty, always. It must never reveal whether a tenant
 * exists, which plan it is on, or whether the event was recognised.
 */
@Controller({ path: 'webhooks/billing', version: VERSION_NEUTRAL })
@PlatformRoute()
@UseFilters(ApiExceptionFilter)
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(private readonly webhooks: BillingWebhookService) {}

  /**
   * `POST /api/webhooks/billing` — one delivery.
   *
   * The body is read from `req.rawBody`, which exists because the application is
   * created with Nest's `rawBody` option. Verifying a signature over a body that
   * was parsed and re-serialised cannot work, and the failure gets diagnosed as
   * a wrong secret every time.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() request: RawBodyRequest<Request>): Promise<void> {
    try {
      const outcome = await this.webhooks.ingest(
        request.rawBody,
        request.headers as Record<string, string | undefined>,
      );

      if (outcome === 'duplicate') {
        this.logger.debug('Absorbed a duplicate billing delivery');
      }
    } catch (error: unknown) {
      if (error instanceof BillingWebhookRefusedError) {
        // The *reason* — wrong signature, stale timestamp, a secret this
        // environment was never given — goes to the log and never to an
        // anonymous caller, for whom the difference is a reconnaissance signal.
        this.logger.warn(`Billing webhook refused: ${error.reason}`);

        throw new ApiException('webhook_signature_invalid', error.message);
      }

      throw error;
    }
  }
}
