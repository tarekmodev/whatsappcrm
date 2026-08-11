import type { ReactNode } from 'react';
import { Stack } from '@/components/layout/Stack';
import styles from './AuthCard.module.css';

/**
 * The card every signed-out screen renders into. Usage:
 * `<AuthCard title={…} description={…}>{form}</AuthCard>`.
 *
 * It owns the `<h1>`, so each auth route has exactly one and heading order is
 * correct by construction. Sign-in, invite acceptance and every state they can
 * be in — including the loading skeleton and the dead-link message — share this
 * outline, which is what makes swapping between them produce no layout shift.
 */
export function AuthCard({
  title,
  children,
  description,
}: {
  title: string;
  children: ReactNode;
  description?: string;
}) {
  return (
    <Stack gap="5" as="section" className={styles.card}>
      <Stack gap="2">
        <h1 className={styles.title}>{title}</h1>
        {description === undefined ? null : <p className={styles.description}>{description}</p>}
      </Stack>
      {children}
    </Stack>
  );
}
