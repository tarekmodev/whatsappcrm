'use client';

import { useContent } from '@/lib/content';
import styles from './HandoffMessagePreview.module.css';

/**
 * The handoff message as the customer will receive it. Usage, under the field:
 * `<HandoffMessagePreview message={handoffMessage} />`.
 *
 * **The console's own outbound bubble, not a WhatsApp skin** (TAR-813). No
 * WhatsApp green, no phone frame, no tick marks: this is the same surface the
 * inbox draws an outbound message on, built from the same accent-subtle roles,
 * so what an admin sees here is what their team will see in the thread. A mockup
 * of somebody else's client would be promising a fidelity we do not control and
 * cannot test.
 *
 * **Empty is a real setting, not a missing one.** `handoffMessage: null` means
 * the chatbot hands over without saying anything — a deliberate choice for a
 * workspace whose agents open with their own greeting — so the empty state says
 * that in words rather than showing a blank bubble.
 *
 * A picture, hidden from the accessibility tree: the field above it already
 * holds the same text, in an editable control with a label, and a screen reader
 * hearing it twice would be reading a duplicate rather than a preview. The
 * caption naming what the region is stays visible.
 */
export function HandoffMessagePreview({ message }: { message: string }) {
  const content = useContent();
  const trimmed = message.trim();

  return (
    <div className={styles.preview}>
      <p className={styles.caption}>{content.chatbot.handoffPreviewLabel}</p>
      {trimmed === '' ? (
        <p className={styles.silent}>{content.chatbot.handoffPreviewEmpty}</p>
      ) : (
        <p className={styles.bubble} aria-hidden="true">
          {message}
        </p>
      )}
    </div>
  );
}
