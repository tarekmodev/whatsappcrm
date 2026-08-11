import Link from 'next/link';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './TextLink.module.css';

/**
 * A standalone internal link that is also a touch target. Usage:
 * `<TextLink href={routes.login()}>Back to sign in</TextLink>`.
 *
 * `next/link`, so client routing and prefetch work — a plain anchor is only for
 * external links and downloads. The class is what separates this from a link
 * inside a paragraph: on its own below a form it is a tap target, and WCAG's
 * inline-text exemption does not apply to it.
 */
export function TextLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} className={cx(styles.link, className)}>
      {children}
    </Link>
  );
}
