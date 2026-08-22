'use client';

import { useEffect, useRef } from 'react';
import { useContent } from '@/lib/content';
import styles from './FormError.module.css';

/**
 * A form's top-level failure message, drawn as a `Notice` in the danger role.
 * Usage: `<FormError message={formError} requestId={requestId} />` — renders
 * nothing when `message` is `null`, so a caller needs no conditional of its own.
 *
 * `role="alert"` so the failure is announced without the user having to hunt for
 * it, and it is placed above the actions rather than below the fold. Field-level
 * errors are separate and stay next to their control.
 *
 * Shared by the dialog forms and the page-level auth forms: a failure that looks
 * different depending on which surface produced it reads as two different bugs.
 * It composes `Notice`'s rules rather than restating them, so the danger tone is
 * declared in exactly one module file.
 */
export function FormError({
  message,
  requestId,
  shouldTakeFocus = false,
}: {
  message: string | null;
  requestId?: string | null;
  /**
   * Moves focus to the message when it appears. For a form that owns its screen:
   * the control the user pressed is at the bottom, the failure is at the top, and
   * `role="alert"` announces it but leaves a keyboard user where they were. Off
   * by default because inside a dialog focus is already trapped a line away, and
   * moving it there would fight the dialog's own focus management.
   */
  shouldTakeFocus?: boolean;
}) {
  const content = useContent();
  const messageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shouldTakeFocus && message !== null) {
      messageRef.current?.focus();
    }
  }, [message, shouldTakeFocus]);

  if (message === null) {
    return null;
  }

  return (
    // Two wrappers for one message, and both earn their place: the outer pair
    // animates the message's own height from nothing (see the module file), which
    // a single element cannot do without a hard-coded height.
    <div className={styles.reveal}>
      <div className={styles.revealClip}>
        <div
          ref={messageRef}
          tabIndex={shouldTakeFocus ? -1 : undefined}
          className={styles.formError}
          // The tone `Notice` reads to pick its tint, border and text colour.
          data-tone="danger"
          role="alert"
        >
          <p>{message}</p>
          {requestId === undefined || requestId === null ? null : (
            <p className={styles.requestId}>{content.errors.correlationId(requestId)}</p>
          )}
        </div>
      </div>
    </div>
  );
}
