'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useContent } from '@/lib/content';
import styles from './InboxLayout.module.css';

/**
 * The inbox's frame: filters, the conversation list, the open thread, and the
 * context panel beside it. Usage:
 * `<InboxLayout hasThread={…} filters={…} list={…} thread={…} context={…} />`.
 *
 * A **fixed-height workspace**, not a page of cards: it fills exactly what the
 * top bar left it (`PageShell variant="fill"`), and each region scrolls inside
 * that rather than the document scrolling under all four. The composer is
 * therefore always reachable, and the four regions end at the same edge instead
 * of at four different content heights.
 *
 * How many regions are on screen is a width question the module file answers in
 * CSS — no JavaScript, no viewport measurement, and nothing that could render
 * differently on the server than in the browser:
 *
 *   * **Below 64rem** one region at a time. The filters collapse into their own
 *     disclosure above the list, and opening a conversation replaces the list;
 *     the thread's own back link returns to it.
 *   * **From 64rem** list and thread sit side by side, with the filters still a
 *     band above them and the context panel a band beneath — there is room for
 *     two columns at a readable measure beside the rail, not four.
 *   * **From 84rem** the filters take a column of their own.
 *   * **From 105rem** the context panel takes one too.
 *
 * The list and the thread are both always in the markup. Hiding one with
 * `display: none` rather than dropping it keeps a deep link to a thread
 * server-rendered whole, and keeps the list one back-navigation away rather than
 * one refetch.
 *
 * ## Why each region is a labelled landmark
 *
 * These four used to be `SectionCard`s, and the card's heading was what named
 * them. The cards are gone — a workspace is not three cards floating on a canvas
 * — so the name lives on the region itself. Without it a screen-reader user has
 * no way to jump between the four and has to tab the whole conversation list to
 * reach the reply box.
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
  const content = useContent();
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
        {/* `InboxFilterNav` is itself the labelled `<nav>`; this is only the
            region that gives it a column to fill. */}
        <div className={styles.filters}>{filters}</div>

        {/* The ids are the anchors the cards used to carry, kept on the regions
            that replaced them so nothing linking here breaks. */}
        <section
          id="conversations"
          className={styles.list}
          aria-label={content.inbox.conversationsHeading}
        >
          {list}
        </section>

        <section
          id="conversation"
          className={styles.thread}
          aria-label={content.inbox.threadHeading}
        >
          {thread}
        </section>

        {hasThread && isOpen ? (
          // `tabIndex` because this one scrolls and, on a conversation with no
          // ticket, holds nothing focusable — a scroll container a keyboard user
          // cannot reach is a panel they cannot read.
          <section className={styles.context} aria-label={content.inbox.contextToggle} tabIndex={0}>
            {context}
          </section>
        ) : null}
      </div>
    </ContextPanelContext.Provider>
  );
}
