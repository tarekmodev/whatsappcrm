import Link from 'next/link';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import type { ButtonSize, ButtonVariant } from './Button';
import styles from './ButtonLink.module.css';

/**
 * A link that carries a button's weight. Usage:
 * `<ButtonLink href={routes.login()} variant="primary" isBlock>Back to sign in</ButtonLink>`.
 *
 * For the one case `Button` cannot serve: **the next step after an outcome is a
 * navigation, not an action**. A signed-out screen that has just done its job —
 * the link is sent, the password is set — needs its way forward to look like the
 * primary thing on the card, and a `<button>` with an `onClick` that navigates
 * loses the middle-click, the copy-link and the status bar that make a link a
 * link.
 *
 * It **composes `Button`'s own rules** rather than restating them, so the two
 * cannot drift: the variants, the sizes, the pending opacity and the hover rules
 * all live in `Button.module.css` and are read from there by the same attribute
 * selectors. Anything with a side effect stays a `Button`.
 */

export interface ButtonLinkProps {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders at full width, matching `Button`'s `isBlock`. */
  isBlock?: boolean;
  /** A `mailto:`, a download or another origin — a plain anchor, as `TextLink`. */
  isExternal?: boolean;
  className?: string;
}

export function ButtonLink({
  href,
  children,
  variant = 'secondary',
  size = 'md',
  isBlock = false,
  isExternal = false,
  className,
}: ButtonLinkProps) {
  const attributes = {
    className: cx(styles.buttonLink, className),
    'data-variant': variant,
    'data-size': size,
    'data-block': isBlock ? 'true' : undefined,
  };

  if (isExternal) {
    // `rel` even without `target="_blank"`, on `TextLink`'s reasoning: an editor
    // who later adds one should not have to remember to add this with it.
    return (
      <a {...attributes} href={href} rel="noopener noreferrer">
        {children}
      </a>
    );
  }

  return (
    <Link {...attributes} href={href}>
      {children}
    </Link>
  );
}
