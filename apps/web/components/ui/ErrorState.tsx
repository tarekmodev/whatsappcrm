'use client';

import { Button } from './Button';
import { StateLayout } from './StateLayout';
import { useContent } from '@/lib/content';

/**
 * The shared error fallback for a route or a section. Usage:
 * `<ErrorState onRetry={reset} requestId={…} />`.
 *
 * The user sees the content layer's message, never a stack trace or a raw API
 * error. `requestId` is shown when the API supplied one, so a support
 * conversation can be correlated with the log line.
 *
 * ## Every recoverable error offers a retry
 *
 * `onRetry` is what separates an error state from a dead end. Passing none is a
 * claim that retrying cannot help — make sure it is true before making it.
 *
 * ## Why it always interrupts
 *
 * TAR-515 rules that a recoverable state is announced politely and a blocking
 * one interrupts. This is always the blocking one: it has *replaced* the content
 * the reader asked for, and whether a retry is on offer does not change that
 * they cannot read what they came for until it works. Deriving the politeness
 * from `onRetry` would also put it in the same role as every pending button on
 * the page, since `Spinner` is a `status` — two very different events competing
 * for one announcement.
 *
 * The polite half of that rule belongs to partial data, where a section loaded
 * and only part of it is missing: an inline `Notice` above content that is still
 * there, never this.
 *
 * The anatomy is `StateLayout`'s, shared with `EmptyState`, in `danger` tone: the
 * icon carries the colour and the copy stays readable text. The old treatment
 * tinted the whole box red, which made a section that failed to load shout
 * louder than the ticket that had actually breached its SLA beside it.
 */

export interface ErrorStateProps {
  onRetry?: () => void;
  title?: string;
  description?: string;
  requestId?: string | null;
  /** Overrides "Try again" where the recovery is something else — a reload. */
  retryLabel?: string;
}

export function ErrorState({
  onRetry,
  title,
  description,
  requestId,
  retryLabel,
}: ErrorStateProps) {
  const content = useContent();

  return (
    <StateLayout
      icon="warning"
      tone="danger"
      role="alert"
      title={title ?? content.errors.heading}
      description={description ?? content.errors.body}
      note={
        requestId === undefined || requestId === null
          ? undefined
          : content.errors.correlationId(requestId)
      }
      action={
        onRetry === undefined ? undefined : (
          <Button variant="secondary" onClick={onRetry}>
            {retryLabel ?? content.common.retry}
          </Button>
        )
      }
    />
  );
}
