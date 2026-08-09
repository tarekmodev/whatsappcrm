import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

/** How long a shutting-down process waits for buffered events to reach the tracker. */
const FLUSH_TIMEOUT_MS = 2_000;

export interface ErrorContext {
  /** Low-cardinality values only — these become searchable dimensions in the tracker. */
  tags: Record<string, string>;
  /** Free-form detail attached to the event. Never put personal data here. */
  extra: Record<string, unknown>;
}

/**
 * The application's only route to the error tracker.
 *
 * Sentry is wrapped rather than called directly so the vendor stays replaceable and
 * so there is exactly one place that decides what gets attached to an event —
 * which is also the place to audit when asking whether personal data can leak into
 * a third party.
 *
 * With no `SENTRY_DSN` the SDK was never started (see `instrument.ts`) and every
 * method here is a no-op.
 */
@Injectable()
export class ErrorTrackingService implements OnApplicationShutdown {
  captureException(error: unknown, context: ErrorContext): void {
    Sentry.captureException(error, { tags: context.tags, extra: context.extra });
  }

  /**
   * A container killed mid-flush loses the very events that explain why it was
   * killed, so shutdown waits for the buffer.
   */
  async onApplicationShutdown(): Promise<void> {
    await Sentry.flush(FLUSH_TIMEOUT_MS);
  }
}
