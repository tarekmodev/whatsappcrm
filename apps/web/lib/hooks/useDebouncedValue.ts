'use client';

import { useEffect, useState } from 'react';

/**
 * Delays a value until it has stopped changing. Usage:
 * `const debounced = useDebouncedValue(draft, 300)`.
 *
 * Used for URL-backed search inputs, so typing does not push a navigation per
 * keystroke. The timer is cleared on unmount, so no update fires against a
 * component that has gone away.
 */
/**
 * How long a URL-backed search box waits before it navigates.
 *
 * One number for every search in the console: long enough that a typist does
 * not push a navigation per keystroke, short enough that a pause reads as the
 * list answering. Four call sites each held their own copy of `300`; this is
 * the one they share (TAR-613).
 */
export const SEARCH_DEBOUNCE_MS = 300;

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}
