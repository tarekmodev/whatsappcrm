import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  UseFilters,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  WHATSAPP_SIGNATURE_HEADER,
  WebhookVerifyQuerySchema,
  type WebhookVerifyQuery,
} from '@whatsappcrm/contracts';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { ApiException } from '../common/errors/api.exception';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { WebhookIngestService } from './webhook-ingest.service';
import { WebhookRefusedError } from './webhook.errors';

/**
 * Meta's webhook endpoint. Public, signature-verified, and never
 * cookie-authenticated (TAR-39, endpoint surface).
 *
 * **`VERSION_NEUTRAL`, so the path is `/api/webhooks/whatsapp`.** The URI
 * version prefix is a contract with *our* clients; this URL is registered once
 * inside Meta's dashboard and changing it means an outage plus a manual
 * reconfiguration, so it is deliberately outside the versioning scheme — as the
 * published endpoint table has it.
 *
 * There is no guard. Authentication here *is* the HMAC over the raw body, and a
 * guard would have to duplicate it or run before the raw body is available.
 */
@Controller({ path: 'webhooks/whatsapp', version: VERSION_NEUTRAL })
@UseFilters(ApiExceptionFilter)
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(private readonly ingest: WebhookIngestService) {}

  /**
   * `GET /api/webhooks/whatsapp` — the verification handshake Meta performs once
   * when the webhook URL is registered.
   *
   * The challenge is echoed **verbatim**, as `text/plain`: Meta compares the
   * body byte for byte, and Nest would otherwise label a returned string
   * `text/html`. A wrong token gets 403 and no echo — echoing regardless is how
   * someone else's Meta app ends up pointed at this endpoint.
   */
  @Get()
  @Header('content-type', 'text/plain; charset=utf-8')
  verify(
    @Query(new ZodValidationPipe(WebhookVerifyQuerySchema)) query: WebhookVerifyQuery,
  ): string {
    try {
      return this.ingest.verifyHandshake(query['hub.verify_token'], query['hub.challenge']);
    } catch (error: unknown) {
      throw this.refuse(error, 'forbidden', 'Verification failed.');
    }
  }

  /**
   * `POST /api/webhooks/whatsapp` — an inbound delivery.
   *
   * Answers 200 as soon as the payload is durable and does no processing on the
   * request path. Meta's timeout is short and a slow answer is retried, so
   * anything done here would be done again — and again — under exactly the load
   * that made it slow.
   *
   * The body is read from `req.rawBody`, which exists because the application is
   * created with Nest's `rawBody` option. Signing over a re-serialised body
   * cannot work, and gets diagnosed as a wrong secret.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() request: RawBodyRequest<Request>): Promise<void> {
    try {
      const outcome = await this.ingest.ingestWhatsApp(
        request.rawBody,
        request.headers[WHATSAPP_SIGNATURE_HEADER],
      );

      if (outcome === 'duplicate') {
        this.logger.debug('Absorbed a duplicate WhatsApp delivery');
      }
    } catch (error: unknown) {
      throw this.refuse(error, 'webhook_signature_invalid', 'Signature verification failed.');
    }
  }

  /**
   * Turns a typed refusal into the published envelope, and leaves anything else
   * alone.
   *
   * The response says only that the request was refused. The *reason* — wrong
   * signature, or a secret this environment was never given — goes to the log
   * and never to an anonymous caller, for whom the difference is a
   * reconnaissance signal.
   */
  private refuse(
    error: unknown,
    code: 'forbidden' | 'webhook_signature_invalid',
    message: string,
  ): unknown {
    if (error instanceof WebhookRefusedError) {
      this.logger.warn(error.message);
      return new ApiException(code, message);
    }

    return error;
  }
}
