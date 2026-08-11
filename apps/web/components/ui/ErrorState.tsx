'use client';

import { Button } from './Button';
import { useContent } from '@/lib/content';
import styles from './ErrorState.module.css';

/**
 * The shared error fallback for a route or a section. Usage:
 * `<ErrorState onRetry={reset} requestId={…} />`.
 *
 * The user sees the content layer's message, never a stack trace or a raw API
 * error. `requestId` is shown when the API supplied one, so a support
 * conversation can be correlated with the log line.
 */
export function ErrorState({
  onRetry,
  heading,
  body,
  requestId,
}: {
  onRetry?: () => void;
  heading?: string;
  body?: string;
  requestId?: string | null;
}) {
  const content = useContent();

  return (
    <div className={styles.error} role="alert">
      <p className={styles.heading}>{heading ?? content.errors.heading}</p>
      <p className={styles.body}>{body ?? content.errors.body}</p>
      {requestId === undefined || requestId === null ? null : (
        <p className={styles.requestId}>{content.errors.correlationId(requestId)}</p>
      )}
      {onRetry === undefined ? null : (
        <Button variant="secondary" onClick={onRetry}>
          {content.common.retry}
        </Button>
      )}
    </div>
  );
}
