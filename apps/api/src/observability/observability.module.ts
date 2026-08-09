import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppLoggerService } from './app-logger.service';
import { ErrorTrackingService } from './error-tracking.service';
import { RequestLoggingMiddleware } from './request-logging.middleware';

/**
 * Structured logging, request timing and the exception-to-envelope boundary.
 *
 * Global so no feature module has to import it to log — a module that cannot log
 * without extra wiring ends up with a `console.log` instead.
 */
@Global()
@Module({
  providers: [
    AppLoggerService,
    ErrorTrackingService,
    RequestLoggingMiddleware,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [AppLoggerService, ErrorTrackingService, RequestLoggingMiddleware],
})
export class ObservabilityModule {}
