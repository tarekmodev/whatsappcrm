'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Moves focus to an element the first time it renders. Usage:
 * `const headingRef = useFocusOnMount<HTMLHeadingElement>();`
 *
 * For the moment a form is replaced by its outcome. The control the user just
 * pressed unmounts with the form, and focus falls to `<body>` — so a keyboard
 * user is dropped at the top of the document and a screen-reader user is told
 * nothing happened at all. Focusing the new heading both keeps focus in place and
 * announces the result, without a live region that would say it a second time.
 *
 * Mount only, deliberately: it is the transition that warrants moving focus, not
 * every subsequent render of the panel.
 */
export function useFocusOnMount<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return ref;
}
