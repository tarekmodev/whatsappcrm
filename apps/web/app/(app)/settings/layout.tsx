import type { ReactNode } from 'react';
import { content } from '@/content/en';
import { verifySession } from '@/lib/session/session';
import { settingsNavItems } from '@/components/shell/navigation';
import { NavLinkList } from '@/components/shell/NavLinkList';
import { PageShell } from '@/components/shell/PageShell';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import styles from './layout.module.css';

/**
 * The Settings shell: the sub-navigation, filtered by permission, plus the gate
 * for the whole section.
 *
 * The gate lives here rather than in each page so a settings route added later
 * cannot forget it. It is UX only — the API refuses every request the same way.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { checker } = await verifySession();
  const items = settingsNavItems(checker);

  // Not a single settings section is reachable for this role, so there is nothing
  // here to render — including the sub-navigation itself.
  if (items.length === 0) {
    return (
      <PageShell>
        <ForbiddenState />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <nav aria-label={content.nav.settingsLabel} className={styles.subnav}>
        <NavLinkList items={items} orientation="horizontal" />
      </nav>
      {children}
    </PageShell>
  );
}
