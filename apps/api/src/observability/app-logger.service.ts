import { Inject, Injectable, Optional, type LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { pino, type DestinationStream, type Logger } from 'pino';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Env, LogLevel } from '../config/env.schema';

/**
 * Where log lines are written. Unbound in the application — pino then writes to
 * stdout, which is what a container's log collector reads. Tests bind it to assert
 * on the JSON that is actually emitted, because "the tenant id is on every line"
 * is only worth claiming if something checks it.
 */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

/**
 * Field paths pino removes before anything is written. Centralised here because a
 * credential reaching the log collector is a security incident, not a log-format
 * problem — and the only reliable way to prevent it is to strip at the writer.
 *
 * pino's wildcard matches a single level, so a nested secret is only covered where
 * a path names it. Structured payloads passed to this logger are expected to be
 * shallow for exactly that reason.
 */
const SECRET_KEYS = [
  'authorization',
  'cookie',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
];

const REDACTED_PATHS = [
  ...SECRET_KEYS,
  // pino's `*` matches exactly one level, so top-level and one-deep are separate
  // paths rather than one recursive pattern.
  ...SECRET_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
];

/**
 * The application's only logger.
 *
 * Two jobs in one class, deliberately: it is the `LoggerService` Nest itself
 * writes through (so framework output lands in the same JSON stream as ours), and
 * it hands out pino children for the structured call sites — request completion,
 * unhandled exceptions — that log fields rather than sentences.
 *
 * Tenant attribution is not the caller's responsibility. A pino `mixin` reads
 * TAR-38's {@link TenantContextService} on every write, so `requestId`, `tenantId`
 * and `userId` appear on every line emitted inside a request, a queue job or a
 * WebSocket handler without a single call site remembering to pass them.
 */
@Injectable()
export class AppLoggerService implements LoggerService {
  private readonly root: Logger;

  constructor(
    config: ConfigService<Env, true>,
    private readonly tenantContext: TenantContextService,
    @Optional() @Inject(LOG_DESTINATION) destination?: DestinationStream,
  ) {
    // pino-pretty is a devDependency: a deployed environment must never reach for
    // it, and its log collector wants the JSON anyway.
    const pretty =
      config.get('LOG_PRETTY', { infer: true }) &&
      config.get('NODE_ENV', { infer: true }) !== 'production';

    const options = {
      level: config.get('LOG_LEVEL', { infer: true }),
      base: {
        service: 'api',
        env: config.get('DEPLOY_ENV', { infer: true }),
        version: config.get('APP_VERSION', { infer: true }),
      },
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
      mixin: () => this.tenantFields(),
      // A transport and an explicit destination are mutually exclusive in pino.
      ...(pretty && !destination
        ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
        : {}),
    };

    this.root = destination ? pino(options, destination) : pino(options);
  }

  /** A pino child for structured call sites. `context` mirrors Nest's own logger tag. */
  structured(context: string): Logger {
    return this.root.child({ context });
  }

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  /** Nest calls this as `error(message, stack?, context?)`. */
  error(message: unknown, ...params: unknown[]): void {
    const [first] = params;
    const stack = typeof first === 'string' && first.includes('\n') ? first : undefined;
    const rest = stack ? params.slice(1) : params;

    this.write('error', message, rest, stack);
  }

  private write(level: LogLevel, message: unknown, params: unknown[], stack?: string): void {
    const context = params.find((param): param is string => typeof param === 'string');
    const logger = context ? this.root.child({ context }) : this.root;

    if (typeof message === 'string') {
      logger[level]({ ...(stack ? { stack } : {}) }, message);
      return;
    }

    // Nest occasionally logs an object (a caught error, a config dump). Keep it
    // structured rather than stringifying it into an unsearchable blob.
    logger[level]({ payload: message, ...(stack ? { stack } : {}) }, 'non-string log message');
  }

  private tenantFields(): Record<string, string | null> {
    const context = this.tenantContext.get();

    if (!context) {
      return {};
    }

    return {
      requestId: context.requestId,
      tenantId: context.tenantId,
      userId: context.userId,
    };
  }
}
