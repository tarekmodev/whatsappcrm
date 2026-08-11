import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { pathWithoutQuery } from '../common/http-path';
import type { Env } from '../config/env.schema';
import { AppLoggerService } from './app-logger.service';

/** Probe traffic is constant and uninteresting until it fails, so it logs at `debug`. */
const HEALTH_PATH_PREFIX = '/api/health';

const NANOSECONDS_PER_MILLISECOND = 1e6;

/**
 * One structured line per completed request, carrying the duration and the tenant
 * the work was done for.
 *
 * Middleware rather than an interceptor on purpose: an interceptor only sees
 * requests that reach a handler, so 404s and anything rejected before routing —
 * exactly the traffic worth noticing — would go unlogged.
 *
 * Must be registered *after* `TenantContextMiddleware`, so it runs inside the
 * context scope and the logger's mixin can attach `requestId` and `tenantId`.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly log: Logger;
  private readonly slowThresholdMs: number;

  constructor(logger: AppLoggerService, config: ConfigService<Env, true>) {
    this.log = logger.structured('HTTP');
    this.slowThresholdMs = config.get('SLOW_REQUEST_THRESHOLD_MS', { infer: true });
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    let recorded = false;

    const record = (aborted: boolean): void => {
      if (recorded) {
        return;
      }
      recorded = true;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND;
      const path = pathWithoutQuery(req.originalUrl);
      const slow = durationMs >= this.slowThresholdMs;

      this.log[this.levelFor({ path, statusCode: res.statusCode, slow, aborted })](
        {
          method: req.method,
          path,
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs),
          slow,
          ...(aborted ? { aborted: true } : {}),
        },
        'request completed',
      );
    };

    res.on('finish', () => {
      record(false);
    });
    // A client that disconnects mid-request never fires `finish`, and a request
    // slow enough for the caller to give up is precisely one worth seeing.
    res.on('close', () => {
      record(!res.writableEnded);
    });

    next();
  }

  private levelFor(request: {
    path: string;
    statusCode: number;
    slow: boolean;
    aborted: boolean;
  }): 'debug' | 'info' | 'warn' {
    // 5xx is reported at `error` — with its stack — by AllExceptionsFilter. Logging
    // it at `error` here too would double every incident in the error budget.
    if (request.statusCode >= 500 || request.slow || request.aborted) {
      return 'warn';
    }

    if (request.path.startsWith(HEALTH_PATH_PREFIX)) {
      return 'debug';
    }

    return 'info';
  }
}
