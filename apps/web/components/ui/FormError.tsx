'use client';

import { useContent } from '@/lib/content';
import styles from './FormError.module.css';

/**
 * The form-level failure region, rendered above the actions. Usage:
 * `<FormError message={formError} requestId={requestId} />` — renders nothing
 * when `message` is `null`, so a caller never branches.
 *
 * `role="alert"` so the failure is announced without the user having to hunt for
 * it. Extracted from `FormDialog` once the auth screens needed the identical
 * block outside a dialog: the same failure must look and sound the same wherever
 * a form reports it.
 */
export function FormError({
  message,
  requestId,
}: {
  message: string | null;
  /** Shown when the API supplied one, so support can find the log line. */
  requestId?: string | null;
}) {
  const content = useContent();

  if (message === null) {
    return null;
  }

  return (
    <div className={styles.formError} role="alert">
      <p>{message}</p>
      {requestId === undefined || requestId === null ? null : (
        <p className={styles.requestId}>{content.errors.correlationId(requestId)}</p>
      )}
    </div>
  );
}
