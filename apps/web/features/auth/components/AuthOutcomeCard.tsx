'use client';

import type { ReactNode } from 'react';
import type { IconName } from '@/components/ui/Icon';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { AuthCard, type AuthCardTone } from './AuthCard';
import { useFocusOnMount } from '../useFocusOnMount';
import styles from './AuthOutcomeCard.module.css';

/**
 * What a signed-out screen shows once its form has done its job — the link is
 * sent, the password is set, the link is dead. Usage:
 *
 * ```tsx
 * <AuthOutcomeCard icon="mail" title={…} body={…} action={<ButtonLink …/>} />
 * ```
 *
 * All four outcomes across TAR-61 are the same shape, and building them from one
 * component is what keeps them the same size as the form they replace — so the
 * card does not jump when the swap happens.
 *
 * It takes focus on mount; see `useFocusOnMount` for why that is not optional.
 *
 * ## Why the way out is a button and not a line of link text
 *
 * Every one of these cards is a dead end without one: the form is gone, and the
 * only thing left to do is the thing this names. A `TextLink` under a paragraph
 * reads as a footnote — so the primary way out is a `ButtonLink` carrying the
 * card's weight, and anything secondary stays a link beside it (TAR-521).
 */
export function AuthOutcomeCard({
  icon,
  tone,
  title,
  body,
  detail,
  notice,
  action,
  secondaryAction,
}: {
  /** Decorative; the title carries the meaning. */
  icon: IconName;
  tone?: AuthCardTone;
  title: string;
  body: string;
  /** A second paragraph, e.g. how long the link lasts. */
  detail?: string;
  /** Something the user needs to know rather than something they did. */
  notice?: string;
  /** The next step, as a `ButtonLink` or a `Button`. */
  action: ReactNode;
  secondaryAction?: ReactNode;
}) {
  const headingRef = useFocusOnMount<HTMLHeadingElement>();

  return (
    <AuthCard icon={icon} tone={tone} title={title} headingRef={headingRef}>
      <Stack gap="4">
        <p>{body}</p>
        {detail === undefined ? null : <p className={styles.detail}>{detail}</p>}
        {notice === undefined ? null : <Notice tone="info">{notice}</Notice>}
        <div className={styles.actions}>
          {action}
          {secondaryAction}
        </div>
      </Stack>
    </AuthCard>
  );
}
