import type { ReactNode } from 'react';
import styles from './AlertBanner.module.css';

/**
 * A page-level message with a heading, a body and somewhere to put the way out
 * of it. Usage:
 *
 * ```tsx
 * <AlertBanner tone="warning" heading="You are close to your allowance" action={<TextLink …/>}>
 *   842 of 1,000 conversations for this period.
 * </AlertBanner>
 * ```
 *
 * `Notice` is the smaller sibling and stays the right choice for a single
 * sentence inside a card. This is for something the page needs somebody to read
 * *before* they carry on with what they came for, which is why it carries a
 * heading and an action slot — "you are over your allowance" without "here is
 * what to do about it" is the half of the message that matters least.
 *
 * `role="status"`, not `role="alert"`: everything rendered through this was
 * already true when the page loaded, and an assertive live region would
 * interrupt a screen-reader user reading the heading to announce something the
 * page is about to say anyway.
 */

export const ALERT_BANNER_TONES = ['info', 'warning', 'danger'] as const;
export type AlertBannerTone = (typeof ALERT_BANNER_TONES)[number];

export interface AlertBannerProps {
  heading: string;
  children: ReactNode;
  tone?: AlertBannerTone;
  /** Kept explicit so a banner inside a section does not break heading order. */
  headingLevel?: 2 | 3;
  /** The way out: a link to the page that fixes it, or a button that does. */
  action?: ReactNode;
}

export function AlertBanner({
  heading,
  children,
  tone = 'info',
  headingLevel = 2,
  action,
}: AlertBannerProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  return (
    <section role="status" className={styles.banner} data-tone={tone}>
      <Heading className={styles.heading}>{heading}</Heading>
      <div className={styles.body}>{children}</div>
      {action === undefined ? null : <div className={styles.action}>{action}</div>}
    </section>
  );
}
