import type { ReactNode } from 'react';
import styles from './InboxPanes.module.css';

/**
 * The inbox's master-detail frame. Usage:
 * `<InboxPanes list={…} thread={…} hasThread={…} />`.
 *
 * Two panes side by side once there is room for both, and one pane before that:
 * on a phone, opening a conversation replaces the list, and the thread's own
 * back link returns to it. Which pane shows is a data attribute the module file
 * reads, so the switch is CSS — no JavaScript, no viewport measurement, and
 * nothing that could render differently on the server than in the browser.
 *
 * Both panes are always in the markup. Hiding one with `display: none` rather
 * than dropping it keeps a deep link to a thread server-rendered whole, and
 * keeps the list one back-navigation away rather than one refetch.
 */
export function InboxPanes({
  list,
  thread,
  hasThread,
}: {
  list: ReactNode;
  thread: ReactNode;
  hasThread: boolean;
}) {
  return (
    <div className={styles.panes} data-has-thread={hasThread ? 'true' : 'false'}>
      <div className={styles.listPane}>{list}</div>
      <div className={styles.threadPane}>{thread}</div>
    </div>
  );
}
