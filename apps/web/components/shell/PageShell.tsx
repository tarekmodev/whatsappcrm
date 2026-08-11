import type { ReactNode } from 'react';
import { Container } from '@/components/layout/Container';
import { Stack } from '@/components/layout/Stack';
import styles from './PageShell.module.css';

/**
 * The vertical frame a route's sections sit in. Usage:
 * `<PageShell>{sections}</PageShell>`.
 *
 * Exists so a page file never writes padding or a container of its own — page
 * files stay composition-only, and every route lines up at every width.
 */
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <Container size="xl" className={styles.shell}>
      <Stack gap="5">{children}</Stack>
    </Container>
  );
}
