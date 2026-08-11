'use client';

import type { ReactNode } from 'react';
import { Notice } from '@/components/ui/Notice';
import { Stack } from '@/components/layout/Stack';
import { AuthCard } from './AuthCard';
import { useFocusOnMount } from '../useFocusOnMount';
import styles from './AuthOutcomeCard.module.css';

/**
 * What a signed-out screen shows once its form has done its job — the link is
 * sent, the password is set, the link is dead. Usage:
 *
 * ```tsx
 * <AuthOutcomeCard title={…} body={…} notice={…} actions={<Link …/>} />
 * ```
 *
 * All three outcomes across TAR-61 are the same shape, and building them from one
 * component is what keeps them the same size as the form they replace — so the
 * card does not jump when the swap happens.
 *
 * It takes focus on mount; see `useFocusOnMount` for why that is not optional.
 */
export function AuthOutcomeCard({
  title,
  body,
  detail,
  notice,
  actions,
}: {
  title: string;
  body: string;
  /** A second paragraph, e.g. how long the link lasts. */
  detail?: string;
  /** Something the user needs to know rather than something they did. */
  notice?: string;
  actions?: ReactNode;
}) {
  const headingRef = useFocusOnMount<HTMLHeadingElement>();

  return (
    <AuthCard title={title} headingRef={headingRef}>
      <Stack gap="4">
        <p>{body}</p>
        {detail === undefined ? null : <p className={styles.detail}>{detail}</p>}
        {notice === undefined ? null : <Notice tone="info">{notice}</Notice>}
        {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
      </Stack>
    </AuthCard>
  );
}
