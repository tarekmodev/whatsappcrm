import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiErrorDetailSchema,
  httpStatusForErrorCode,
  type ApiError,
  type ApiErrorDetail,
} from '@whatsappcrm/contracts';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import { isTenantNotActiveError, TENANT_INACTIVE_MESSAGE } from '../common/errors/tenant-inactive';
import { pathWithoutQuery, withoutEmbeddedQuery } from '../common/http-path';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Env } from '../config/env.schema';
import { AppLoggerService } from './app-logger.service';
import { ErrorTrackingService } from './error-tracking.service';

const DetailsSchema = z.array(ApiErrorDetailSchema);

/**
 * A thrown `HttpException` may carry a stable code and field details; anything it
 * does not carry is derived from the status.
 */
const HttpExceptionPayloadSchema = z.object({
  code: z.string().min(1).optional(),
  message: z.union([z.string(), z.array(z.string())]).optional(),
  details: z.unknown().optional(),
});

const GENERIC_SERVER_ERROR_MESSAGE =
  'Something went wrong. Quote the request id when reporting this.';

/** Compared against a plain `number`, so not `HttpStatus` — the enum comparison is unsound. */
const LOWEST_SERVER_ERROR_STATUS = 500;

interface DescribedError {
  status: number;
  code: string;
  message: string;
  details?: ApiErrorDetail[];
}

/**
 * The single place an exception becomes a response, a log line and a tracker event.
 *
 * Everything here exists to satisfy one rule: a caller gets a stable envelope and
 * never a stack trace, while an engineer gets the stack, the tenant and the request
 * id — correlated by the same `requestId` the caller was shown.
 *
 * TAR-39 owns the error-code taxonomy. Until it lands, codes are derived from the
 * HTTP status so they are at least stable and machine-readable, and a thrown
 * exception may override the code by carrying one in its payload.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log: Logger;
  private readonly exposeInternalMessages: boolean;

  constructor(
    logger: AppLoggerService,
    config: ConfigService<Env, true>,
    private readonly tenantContext: TenantContextService,
    private readonly errorTracking: ErrorTrackingService,
  ) {
    this.log = logger.structured('ExceptionFilter');
    this.exposeInternalMessages = config.get('NODE_ENV', { infer: true }) !== 'production';
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const requestId = this.tenantContext.requestId ?? 'unknown';
    const described = this.describe(exception, request);
    const isServerError = described.status >= LOWEST_SERVER_ERROR_STATUS;

    this.report(exception, described, request, isServerError);

    // Nothing useful can be sent once the response has begun streaming; the log
    // and the tracker event above are the whole record in that case.
    if (response.headersSent) {
      return;
    }

    const body: ApiError = {
      error: {
        code: described.code,
        message:
          isServerError && !this.exposeInternalMessages
            ? GENERIC_SERVER_ERROR_MESSAGE
            : described.message,
        ...(described.details ? { details: described.details } : {}),
        requestId,
      },
    };

    response.status(described.status).json(body);
  }

  private report(
    exception: unknown,
    described: DescribedError,
    request: Request,
    isServerError: boolean,
  ): void {
    const path = pathWithoutQuery(request.originalUrl);
    const fields = {
      method: request.method,
      path,
      statusCode: described.status,
      code: described.code,
    };

    if (!isServerError) {
      // An expected rejection — unauthorised, not found, validation. Worth a line,
      // not worth a stack or an alert.
      this.log.warn(fields, described.message);
      return;
    }

    this.log.error(
      { ...fields, stack: exception instanceof Error ? exception.stack : undefined },
      described.message,
    );

    this.errorTracking.captureException(exception, {
      tags: {
        requestId: this.tenantContext.requestId ?? 'unknown',
        tenantId: this.tenantContext.tenantId ?? 'none',
        code: described.code,
      },
      extra: fields,
    });
  }

  private describe(exception: unknown, request: Request): DescribedError {
    // Framework messages embed the request URL. Strip the query string once, here,
    // so neither the log line nor the response body can carry a token from it.
    const sanitise = (message: string): string =>
      withoutEmbeddedQuery(message, request.originalUrl);

    // Before the catch-all below, because this one is not a fault (TAR-539). It
    // reaches here whenever the data layer refuses a statement outside a
    // controller's own `catch` — session resolution in a guard is the path QA
    // reproduced it on — and the default answer was a 500 whose body carried
    // `TenantPrisma`, the failing model and the tenant's UUID. Both halves of
    // that are wrong: an operator suspending a tenant is a state, not a fault,
    // and a locked-out caller is the last person who should be shown the shape
    // of the data layer. `TenantStatusGuard` (TAR-36) refuses at stage 4 and
    // this stays as the net behind it, for the paths a guard cannot see: an
    // interceptor, a route added later, a tenant suspended mid-request.
    if (isTenantNotActiveError(exception)) {
      return {
        status: httpStatusForErrorCode('subscription_inactive'),
        code: 'subscription_inactive',
        message: TENANT_INACTIVE_MESSAGE,
      };
    }

    if (!(exception instanceof HttpException)) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'internal_error',
        message: sanitise(exception instanceof Error ? exception.message : 'Unhandled exception'),
      };
    }

    const status = exception.getStatus();
    const payload = HttpExceptionPayloadSchema.safeParse(exception.getResponse());
    const details = DetailsSchema.safeParse(payload.data?.details);
    const message = payload.data?.message;

    return {
      status,
      code: payload.data?.code ?? codeForStatus(status),
      message: sanitise(
        Array.isArray(message) ? message.join('; ') : (message ?? exception.message),
      ),
      ...(details.success ? { details: details.data } : {}),
    };
  }
}

/**
 * `HttpStatus` is a numeric enum, so it reverse-maps a status onto its name —
 * `404` to `NOT_FOUND`. That gives a stable, machine-readable code with no lookup
 * table to drift out of date.
 */
function codeForStatus(status: number): string {
  const name: unknown = (HttpStatus as unknown as Record<number, string | undefined>)[status];

  return typeof name === 'string' ? name.toLowerCase() : 'internal_error';
}
