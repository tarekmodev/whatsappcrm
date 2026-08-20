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
 */
export function NoThreadSelected() {
  return (
    <div className={styles.thread}>
      <div className={styles.state}>
        <EmptyState heading={content.inbox.noThreadHeading} body={content.inbox.noThreadBody} />
      </div>
    </div>
  );
}
