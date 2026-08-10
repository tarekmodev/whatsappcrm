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
