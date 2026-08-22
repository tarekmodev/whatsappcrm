import Link from 'next/link';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './TextLink.module.css';

/**
 * A standalone link that is also a touch target. Usage:
 * `<TextLink href={routes.login()}>Back to sign in</TextLink>`, or
 * `<TextLink href={mailto(address)} isExternal>Contact support</TextLink>`.
 *
 * `next/link` by default, so client routing and prefetch work. The class is what
 * separates this from a link inside a paragraph: on its own below a form it is a
 * tap target, and WCAG's inline-text exemption does not apply to it.
 *
 * `isExternal` drops to a plain anchor, which is the correct element for a
 * `mailto:`, a `tel:`, a download or another origin — `next/link` would try to
 * prefetch and client-route a destination that is not a route. It is a prop
 * rather than a second component because the two are the same link with the same
 * styling, and a fork would have been two things to restyle.
 */
export function TextLink({
  href,
  children,
  className,
  isExternal = false,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  isExternal?: boolean;
}) {
  if (isExternal) {
    return (
      // `rel` even without `target="_blank"`: a future editor adding one should
      // not have to remember to add this with it.
      <a href={href} className={cx(styles.link, className)} rel="noopener noreferrer">
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={cx(styles.link, className)}>
      {children}
    </Link>
  );
}
