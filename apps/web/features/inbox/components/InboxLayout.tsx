'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import styles from './InboxLayout.module.css';

/**
 * The inbox's frame: filters, the conversation list, the open thread, and the
 * context panel beside it. Usage:
 * `<InboxLayout hasThread={…} filters={…} list={…} thread={…} context={…} />`.
 *
 * Four regions, and how many are on screen is a width question the module file
 * answers in CSS — no JavaScript, no viewport measurement, and nothing that
 * could render differently on the server than in the browser:
 *
 *   * **Below 64rem** one region at a time. The filters collapse into their own
 *     disclosure above the list, and opening a conversation replaces the list;
 *     the thread's own back link returns to it.
 *   * **From 64rem** filters, list and thread sit side by side, with the context
 *     panel as a band under them — there is room for three columns at a readable
 *     measure, not four.
 *   * **From 90rem** the context panel takes its own column.
 *
 * The list and the thread are both always in the markup. Hiding one with
 * `display: none` rather than dropping it keeps a deep link to a thread
 * server-rendered whole, and keeps the list one back-navigation away rather than
 * one refetch.
 *
 * ## Why the context panel's state lives here
 *
 * The control that shows and hides it is in the thread's header, and the panel
 * is a sibling of the thread — so one of them has to own the state, and it is
 * the frame. Client state rather than the URL on purpose: which filter you are
 * on and which conversation you have open are worth sharing in a link, and
 * whether you had a side panel open is not.
 */

interface ContextPanelValue {
  readonly isOpen: boolean;
  readonly toggle: () => void;
}

const ContextPanelContext = createContext<ContextPanelValue | null>(null);

/**
 * The context panel's state, for the one control that changes it. Throws outside
 * the layout rather than assuming a default: a toggle rendered where there is no
 * panel is a mistake, not a no-op.
 */
export function useContextPanel(): ContextPanelValue {
  const value = useContext(ContextPanelContext);

  if (value === null) {
    throw new Error('useContextPanel must be used inside <InboxLayout>.');
  }

  return value;
}

export interface InboxLayoutProps {
  hasThread: boolean;
  filters: ReactNode;
  list: ReactNode;
  thread: ReactNode;
  /** Rendered only alongside an open thread — it describes that conversation. */
  context: ReactNode;
}

export function InboxLayout({ hasThread, filters, list, thread, context }: InboxLayoutProps) {
  const [isOpen, setIsOpen] = useState(true);
  const value = useMemo<ContextPanelValue>(
    () => ({
      isOpen,
      toggle: () => {
        setIsOpen((current) => !current);
      },
    }),
    [isOpen],
  );

  return (
    <ContextPanelContext.Provider value={value}>
      <div
        className={styles.layout}
        data-has-thread={hasThread ? 'true' : 'false'}
        data-context={isOpen ? 'open' : 'closed'}
      >
        <div className={styles.filters}>{filters}</div>
        <div className={styles.list}>{list}</div>
        <div className={styles.thread}>{thread}</div>
        {hasThread && isOpen ? <div className={styles.context}>{context}</div> : null}
      </div>
    </ContextPanelContext.Provider>
  );
}
