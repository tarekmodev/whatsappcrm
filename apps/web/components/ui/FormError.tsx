'use client';

import { useContent } from '@/lib/content';
import styles from './FormError.module.css';

/**
 * A form's top-level failure message. Usage:
 * `<FormError message={formError} requestId={requestId} />` — renders nothing
 * when `message` is `null`, so a caller needs no conditional of its own.
 *
 * `role="alert"` so the failure is announced without the user having to hunt for
 * it, and it is placed above the actions rather than below the fold. Field-level
 * errors are separate and stay next to their control.
 *
 * Shared by the dialog forms and the page-level auth forms: a failure that looks
 * different depending on which surface produced it reads as two different bugs.
 */
export function FormError({
  message,
  requestId,
}: {
  message: string | null;
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
