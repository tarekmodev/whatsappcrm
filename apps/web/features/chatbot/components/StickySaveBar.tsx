'use client';

import { useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { useToastClearance } from '@/components/ui/useToastClearance';
import { useContent } from '@/lib/content';
import styles from './StickySaveBar.module.css';

/**
 * The commit for the fields that are saved together. Usage, last inside the
 * form: `<StickySaveBar changeCount={3} isPending={…} onCancel={…} />`.
 *
 * **Shown only when there is something to save**, and never for anything that
 * has already saved itself. Three commit behaviours share this page — the master
 * switch writes on flip, each source writes from its own dialog, and stages B, C
 * and D are one form — and the bar belongs to the third alone. A bar that
 * appeared because somebody deleted a source would be claiming their work was
 * unsaved when it was already gone.
 *
 * **One request across three cards.** They are three cards because they are
 * three ideas, not three resources: `PATCH /ai/config` takes all of it, and
 * splitting the commit would be three round trips and three ways to fail for one
 * endpoint.
 *
 * `position: sticky` rather than `fixed`, so the bar is part of the form's flow
 * and reserves its own height — the last field is never covered, with no padding
 * to keep in step with a measurement taken somewhere else. It publishes its
 * clearance so a toast stacks above it rather than over the button that fired
 * it, which is the same seam the inbox composer uses.
 *
 * The error renders inline, above the buttons, and never as a toast: a save that
 * failed is about this form, and a message that slides away takes the reason with
 * it while the reader is still looking at the fields that caused it.
 */
export function StickySaveBar({
  changeCount,
  isPending,
  formError,
  requestId,
  onCancel,
}: {
  changeCount: number;
  isPending: boolean;
  formError: string | null;
  requestId: string | null;
  onCancel: () => void;
}) {
  const content = useContent();
  const ref = useRef<HTMLDivElement>(null);

  useToastClearance(ref);

  return (
    <div
      ref={ref}
      className={styles.bar}
      // Named, so a screen-reader user who has scrolled into it knows what the
      // two buttons at the bottom of their viewport belong to.
      role="region"
      aria-label={content.chatbot.saveBarLabel}
    >
      <FormError message={formError} requestId={requestId} />
      <div className={styles.row}>
        <p className={styles.count}>{content.chatbot.unsavedChanges(changeCount)}</p>
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {content.chatbot.discardChanges}
          </Button>
          {/* The fields stay editable while this is pending: a save in flight is
              not a reason to stop somebody correcting a typo they just spotted. */}
          <Button type="submit" variant="primary" isPending={isPending}>
            {content.chatbot.saveSettings}
          </Button>
        </div>
      </div>
    </div>
  );
}
