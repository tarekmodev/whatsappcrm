'use client';

import { useEffect, useState } from 'react';
import { msUntilClose, serviceWindowAt, type ServiceWindow } from '@/features/inbox/service-window';

/**
 * The service window as it stands *now*, re-evaluated when it closes rather than
 * when the page is next loaded. Usage:
 *
 * ```tsx
 * const window = useServiceWindow(conversation.serviceWindowExpiresAt, initialWindow);
 * ```
 *
 * The initial value is computed on the server and passed in, so the first client
 * render produces the markup the server sent. Evaluating `Date.now()` during
 * render instead would make the two disagree and the composer would hydrate into
 * a mismatch — the same reason `RelativeTime` defers.
 *
 * The timer is what the agent is really here for. A window that closed while a
 * reply was half-typed used to be discovered by pressing Send and reading
 * `whatsapp_window_expired`; this flips the composer at the moment it happens,
 * with the draft still on screen.
 */
export function useServiceWindow(
  serviceWindowExpiresAt: string | null,
  initial: ServiceWindow,
): ServiceWindow {
  const [window, setWindow] = useState<ServiceWindow>(initial);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (): void => {
      const current = serviceWindowAt(serviceWindowExpiresAt, new Date());

      setWindow(current);

      if (current.state === 'closed') {
        return;
      }

      // `setTimeout` silently fires immediately past its 32-bit ceiling, so a
      // long delay is capped and re-checked rather than trusted. A real window
      // is at most 24 hours and never reaches this; a corrupted column would,
      // and would otherwise spin.
      timer = setTimeout(
        settle,
        Math.min(Math.max(msUntilClose(current, new Date()), MIN_DELAY_MS), MAX_DELAY_MS),
      );
    };

    settle();

    return () => {
      clearTimeout(timer);
    };
  }, [serviceWindowExpiresAt]);

  return window;
}

const MIN_DELAY_MS = 1;
/** `setTimeout`'s 32-bit signed ceiling, past which the delay wraps to zero. */
const MAX_DELAY_MS = 2_147_483_647;
