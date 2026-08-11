'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { MAIN_CONTENT_ID } from '@/components/shell/main-content';
import { oppositeRailState, type RailState } from '@/lib/shell/rail';
import { setRailStateAction } from './rail.actions';
import styles from './AppShell.module.css';

/**
 * The signed-in console frame: the navigation rail, the top bar and `<main>`.
 * Usage: `<AppShell initialRailState={state} rail={…} bar={…}>{children}</AppShell>`.
 *
 * A client component because the rail's width is interactive, and the *only*
 * one in the frame: `rail`, `bar` and `children` arrive as props already
 * rendered on the server, so nothing they contain is pulled into the client
 * bundle by this file. That is the whole reason they are props rather than
 * imports.
 *
 * The initial width comes from the cookie the server already read, so the frame
 * is the right size in the first HTML response — the choice is persisted for the
 * next request, not read back on this one.
 */

interface RailContextValue {
  readonly isCollapsed: boolean;
  readonly toggle: () => void;
}

const RailContext = createContext<RailContextValue | null>(null);

/**
 * The rail's state, for the two controls that need it. Throws outside the shell
 * rather than assuming a width: a rail control rendered somewhere without a rail
 * is a mistake, not a default.
 */
export function useRail(): RailContextValue {
  const value = useContext(RailContext);

  if (value === null) {
    throw new Error('useRail must be used inside <AppShell>.');
  }

  return value;
}

export interface AppShellProps {
  initialRailState: RailState;
  /** The navigation rail. Hidden below the layout breakpoint, where the drawer takes over. */
  rail: ReactNode;
  bar: ReactNode;
  children: ReactNode;
}

export function AppShell({ initialRailState, rail, bar, children }: AppShellProps) {
  const [state, setState] = useState<RailState>(initialRailState);
  const [, startTransition] = useTransition();

  const toggle = useCallback(() => {
    const next = oppositeRailState(state);

    // Applied locally first so the rail moves on the click, then persisted for
    // the next request. Nothing on this page waits for the cookie write.
    setState(next);
    startTransition(async () => {
      await setRailStateAction(next);
    });
  }, [state]);

  return (
    <RailContext.Provider value={{ isCollapsed: state === 'collapsed', toggle }}>
      <div className={styles.frame} data-rail={state}>
        {rail}
        <div className={styles.column}>
          {bar}
          {/*
            `tabIndex={-1}` makes the landmark focusable programmatically but
            keeps it out of the tab order — needed by the skip link and as the
            fallback target when a dialog's invoker no longer exists on close.
          */}
          <main id={MAIN_CONTENT_ID} tabIndex={-1} className={styles.main}>
            {children}
          </main>
        </div>
      </div>
    </RailContext.Provider>
  );
}
