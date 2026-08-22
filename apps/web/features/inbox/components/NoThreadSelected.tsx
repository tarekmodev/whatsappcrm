import { EmptyState } from '@/components/ui/EmptyState';
import { content } from '@/content/en';
// The same column interior the real thread uses, so picking a conversation
// swaps the contents rather than resizing the column around them.
import styles from './ThreadSection.module.css';

/**
 * What the thread column shows before a conversation is picked. Usage:
 * `<NoThreadSelected />` as the `thread` slot of `InboxLayout`.
 *
 * It only ever appears at widths where both the list and the thread are on
 * screen — below that, no thread means the list is the whole screen.
 *
 * `tone="quiet"` and one line, with no action: nothing is wrong here and there
 * is no next step to name that is not already the list beside it. Drawing this
 * with the disc, the heading and the body the other states get would make an
 * ordinary resting position look like a problem.
 */
export function NoThreadSelected() {
  return (
    <div className={styles.thread}>
      <div className={styles.state}>
        <EmptyState icon="conversation" tone="quiet" title={content.inbox.noThreadHeading} />
      </div>
    </div>
  );
}
