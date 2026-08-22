'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { cx } from '@/lib/cx';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';
import { useContent } from '@/lib/content';
import { Button } from './Button';
import { Icon } from './Icon';
import { MenuButton } from './MenuButton';
import { Spinner } from './Spinner';
import styles from './RowActions.module.css';

/**
 * The actions at the end of a table row, with the weight ladder applied. Usage:
 *
 * ```tsx
 * <RowActions
 *   subject={user.displayName}
 *   actions={[
 *     { key: 'edit', label: 'Edit', accessibleName: `Edit ${name}`, onSelect: … },
 *     { key: 'remove', label: 'Remove', accessibleName: `Remove ${name}`,
 *       onSelect: …, isDestructive: true },
 *   ]}
 * />
 * ```
 *
 * Four settings tables had independently arrived at the same wrong answer:
 * `Edit` outlined, and the irreversible action beside it a bare text button in
 * ordinary body colour — so the most dangerous control in the row was also the
 * quietest (TAR-709). The ladder is the rule stated once, in one component, so
 * the fifth table inherits it instead of picking:
 *
 * - **Two actions** render inline: the ordinary one at `secondary`, the
 *   destructive one at `dangerQuiet`, held apart by `--space-3` so the control a
 *   user reaches for most is never adjacent to the one that cannot be undone.
 * - **Three or more** keep the single most-used action inline — the first in the
 *   array — and move the rest, destructive included, into an overflow menu.
 * - The destructive action is **always last**, and never the first tab stop of
 *   the row.
 *
 * Danger is carried by position and by the verb in the label as well as by
 * colour, so it survives forced-colors mode and a reader who cannot see red.
 */

export interface RowAction {
  /** Stable key. Also what React lists the controls by. */
  key: string;
  /** The verb, as shown: `Edit`, `Delete`. */
  label: string;
  /**
   * What a screen reader hears — the verb **and the subject**. Four rows of
   * identical "Delete" is a table nobody can use without sight of it.
   */
  accessibleName: string;
  onSelect: () => void;
  /**
   * Marks the irreversible one. At most one per row: a cluster with two would
   * have no answer to which of them goes last.
   */
  isDestructive?: boolean;
  /**
   * For an action that mutates directly rather than opening a dialog — the
   * knowledge base's "Index again". Shown in place of the control's own label
   * while inline, and on the overflow trigger once the action is in the menu,
   * which is where it has to go: the menu closes on select, so a spinner drawn
   * on the entry itself would leave with it.
   */
  isPending?: boolean;
}

export interface RowActionsProps {
  actions: readonly RowAction[];
  /** The row's own name, for the overflow trigger's accessible name. */
  subject: string;
  className?: string;
}

/** How many actions a row may render inline before the rest collapse. */
export const INLINE_ROW_ACTION_LIMIT = 2;

export function RowActions({ actions, subject, className }: RowActionsProps) {
  const content = useContent();
  const rootRef = useRowFocusAnchor();

  // Destructive last, whatever order the caller wrote them in — the position is
  // half of what makes it read as destructive, so it is not the caller's to get
  // wrong.
  const ordered = [
    ...actions.filter((action) => action.isDestructive !== true),
    ...actions.filter((action) => action.isDestructive === true),
  ];

  const isCollapsed = ordered.length > INLINE_ROW_ACTION_LIMIT;
  const inline = isCollapsed ? ordered.slice(0, 1) : ordered;
  const overflow = isCollapsed ? ordered.slice(1) : [];
  const pendingInOverflow = overflow.find((action) => action.isPending === true);

  if (ordered.length === 0) {
    return null;
  }

  return (
    <div ref={rootRef} className={cx(styles.actions, className)}>
      {inline.map((action) => (
        <Button
          key={action.key}
          size="sm"
          variant={action.isDestructive === true ? 'dangerQuiet' : 'secondary'}
          className={action.isDestructive === true ? styles.destructive : undefined}
          isPending={action.isPending}
          pendingLabel={action.accessibleName}
          aria-label={action.accessibleName}
          onClick={action.onSelect}
        >
          {action.label}
        </Button>
      ))}

      {overflow.length === 0 ? null : (
        <MenuButton
          label={
            pendingInOverflow === undefined ? (
              <Icon name="more" />
            ) : (
              <Spinner label={pendingInOverflow.accessibleName} />
            )
          }
          accessibleName={content.common.rowActions(subject)}
          triggerClassName={styles.overflowTrigger}
        >
          {({ close }) => (
            <ul className={styles.menuList}>
              {overflow.map((action) => (
                <li
                  key={action.key}
                  className={action.isDestructive === true ? styles.separated : undefined}
                >
                  <button
                    type="button"
                    className={styles.menuItem}
                    data-tone={action.isDestructive === true ? 'danger' : undefined}
                    aria-label={action.accessibleName}
                    onClick={() => {
                      // Closed first, so focus is back on the trigger before a
                      // dialog opens over it — that trigger is where `Modal`
                      // returns focus when the dialog is dismissed.
                      close();
                      action.onSelect();
                    }}
                  >
                    {action.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </MenuButton>
      )}
    </div>
  );
}

/**
 * Keeps the keyboard somewhere sensible when the row this cluster belongs to
 * disappears — the ordinary end of a destructive action.
 *
 * `Modal` already returns focus to whatever opened it, and for a removal that
 * control is about to stop existing: the dialog closes, focus lands back on the
 * row's own button, and the revalidation then takes the row away — dropping
 * focus to `<body>`, where the next Tab starts from the browser chrome.
 *
 * A **layout**-effect cleanup rather than a passive one: it has to read
 * `document.activeElement` while the row is still attached, and a passive
 * cleanup runs after React has detached it, with no siblings left to walk to.
 */
function useRowFocusAnchor(): RefObject<HTMLDivElement | null> {
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;

    return () => {
      if (root === null || !root.contains(document.activeElement)) {
        return;
      }

      focusNextAnchor(root);
    };
  }, []);

  return rootRef;
}

/** Anything in a neighbouring row a keyboard can land on. */
const ROW_FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]';

function focusNextAnchor(root: HTMLElement): void {
  const row = root.closest('tr');

  for (const sibling of [row?.nextElementSibling, row?.previousElementSibling]) {
    const control = sibling?.querySelector<HTMLElement>(ROW_FOCUSABLE) ?? null;

    if (control !== null) {
      control.focus();
      return;
    }
  }

  /*
   * The table is now empty. The main landmark is this app's ruled fallback
   * anchor — `Modal` restores to the same one — and it is focusable, which the
   * section heading above the table is not; giving that heading a `tabindex` to
   * land on would be a second convention for the same job.
   */
  document.getElementById(MAIN_CONTENT_ID)?.focus();
}
