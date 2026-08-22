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
   * Raises an alert for a failure that is **a state, not a throw**.
   *
   * Some operational failures never produce an exception: a billing webhook
   * parked as `failed` (TAR-668) is a row the code wrote on purpose, having
   * decided no retry will help. There is nothing to `captureException` — no
   * stack, and fabricating an `Error` just to have one would file the alert
   * under this method's own call site for every kind of parking there is.
   *
   * Sent at `error` level so it reaches the same alert rules as a 5xx rather
   * than sitting in a feed nobody has muted yet. **`message` is the grouping
   * key**, so it must stay low-cardinality — a stable reason token, never an id
   * or a provider's detail string. Those belong in `extra`, which is what the
   * triaging operator reads.
   */
  captureMessage(message: string, context: ErrorContext): void {
    Sentry.captureMessage(message, {
      level: 'error',
      tags: context.tags,
      extra: context.extra,
    });
  }

  /**
   * A container killed mid-flush loses the very events that explain why it was
   * killed, so shutdown waits for the buffer.
   */
  async onApplicationShutdown(): Promise<void> {
    await Sentry.flush(FLUSH_TIMEOUT_MS);
  }
}
