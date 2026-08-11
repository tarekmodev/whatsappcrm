import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppLoggerService } from './app-logger.service';

/**
 * Records that the process shut down on purpose.
 *
 * Without this line, a rolling deploy and a crash look identical in the log — the
 * output simply stops. It is also the only externally visible proof that Nest's
 * shutdown hooks ran at all, which is what the database disconnect, the Redis
 * quit and the error-tracker flush all hang off: if this line is missing from a
 * container's final output, none of those happened either.
 */
@Injectable()
export class LifecycleLoggerService implements OnApplicationShutdown {
  private readonly log: Logger;

  constructor(logger: AppLoggerService) {
    this.log = logger.structured('Lifecycle');
  }

  onApplicationShutdown(signal?: string): void {
    this.log.info({ signal: signal ?? 'none' }, 'shutting down: draining connections');
  }
}
