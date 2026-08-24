'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useContent } from '@/lib/content';
import { forwardArrowStep } from '@/lib/locale/reading-direction';
import styles from './ThreadComposerTabs.module.css';

/**
 * Where what you type goes: to the customer, or to the team. Usage:
 * `<ThreadComposerTabs reply={<MessageComposer …/>} note={<InternalNotesPanel …/>} />`.
 *
 * The single most consequential control in this product. A note that reached a
 * customer would be the worst bug it could have, so the destination is a
 * **deliberate, labelled choice** at the top of the box rather than a mode you
 * can end up in — and the two are still different entities behind different
 * endpoints, exactly as they were when they sat in two cards.
 *
 * Both panels stay mounted, with the inactive one `hidden`: a half-written reply
 * must survive a glance at the team's notes, and `hidden` takes the panel out of
 * the accessibility tree as well as off the screen, so nothing offers a screen
 * reader two composers at once.
 *
 * Real tab semantics — one tab stop for the strip, arrow keys between the tabs,
 * `aria-selected` and `aria-controls` on each — because that is what `role="tab"`
 * promises and half of it is worse than none.
 */

const TAB_IDS = ['reply', 'note'] as const;
type TabId = (typeof TAB_IDS)[number];

export interface ThreadComposerTabsProps {
  /** The customer-facing composer. */
  reply: ReactNode;
  /** The internal notes panel — never reaches a send path. */
  note: ReactNode;
}

export function ThreadComposerTabs({ reply, note }: ThreadComposerTabsProps) {
  const content = useContent();
  const [active, setActive] = useState<TabId>('reply');
  const baseId = useId();
  const stripRef = useRef<HTMLDivElement>(null);

  const labels: Record<TabId, string> = {
    reply: content.inbox.composerTabReply(content.channels.whatsapp),
    note: content.inbox.composerTabNote,
  };
  const icons: Record<TabId, 'conversation' | 'note'> = { reply: 'conversation', note: 'note' };

  function move(from: TabId, step: number): void {
    const next = TAB_IDS[(TAB_IDS.indexOf(from) + step + TAB_IDS.length) % TAB_IDS.length];

    if (next === undefined) {
      return;
    }

    setActive(next);
    stripRef.current?.querySelector<HTMLElement>(`#${cssId(baseId, next, 'tab')}`)?.focus();
  }

  return (
    // The destination is on the surface as well as in the tab. A note that
    // reached a customer is the worst bug this product could have, so the box an
    // agent is typing into changes colour under them — and the panel itself says
    // in words that only the team sees it, because colour alone is never the
    // carrier of anything that matters (TAR-518).
    <div className={styles.composer} data-destination={active}>
      <div
        ref={stripRef}
        className={styles.strip}
        role="tablist"
        aria-label={content.inbox.composerTabsLabel}
      >
        {TAB_IDS.map((id) => (
          <button
            key={id}
            id={cssId(baseId, id, 'tab')}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={active === id}
            aria-controls={cssId(baseId, id, 'panel')}
            // Roving tabindex: the strip is one tab stop, and the arrows move
            // within it. Two tab stops for two tabs is not a tablist.
            tabIndex={active === id ? 0 : -1}
            onClick={() => {
              setActive(id);
            }}
            onKeyDown={(event) => {
              // WAI-ARIA puts a horizontal tablist's arrows on the *reading*
              // order, not the screen: under `dir="rtl"` the next tab is the one
              // to the left. The vertical pair never mirrors — `ArrowDown` is
              // always the next one, in either direction.
              const forward = forwardArrowStep(event.currentTarget);

              if (event.key === 'ArrowRight') {
                event.preventDefault();
                move(id, forward);
              }

              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                move(id, -forward);
              }

              if (event.key === 'ArrowDown') {
                event.preventDefault();
                move(id, 1);
              }

              if (event.key === 'ArrowUp') {
                event.preventDefault();
                move(id, -1);
              }
            }}
          >
            <Icon name={icons[id]} size="sm" />
            {labels[id]}
          </button>
        ))}
      </div>

      {TAB_IDS.map((id) => (
        <div
          key={id}
          id={cssId(baseId, id, 'panel')}
          role="tabpanel"
          aria-labelledby={cssId(baseId, id, 'tab')}
          className={styles.panel}
          hidden={active !== id}
        >
          {id === 'reply' ? reply : note}
        </div>
      ))}
    </div>
  );
}

/** `useId` produces colons, which are not valid in a CSS selector unescaped. */
function cssId(base: string, tab: TabId, part: 'tab' | 'panel'): string {
  return `${base.replaceAll(':', '')}-${tab}-${part}`;
}
