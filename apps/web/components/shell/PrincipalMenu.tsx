'use client';

import type { ReactNode } from 'react';
import type { SessionPrincipal } from '@whatsappcrm/contracts';
import { Icon } from '@/components/ui/Icon';
import { MenuButton } from '@/components/ui/MenuButton';
import { useContent } from '@/lib/content';
import { PrincipalIdentity } from './PrincipalIdentity';
import styles from './PrincipalMenu.module.css';

/**
 * The bar's account control: who you are, and everything that acts on that.
 * Usage: `<PrincipalMenu principal={principal}>{utilities}</PrincipalMenu>`.
 *
 * The utilities used to sit loose in the bar beside the identity. They are here
 * instead because the set has grown past what a bar can hold at 768px — theme,
 * the role stub while TAR-35 is pending, and sign out — and because grouping
 * them under the person they apply to is what the reference layout does.
 *
 * The controls arrive as `children` already rendered by the server layout, so
 * this file pulls none of them into its own bundle.
 *
 * It is in the bar at **every** width (TAR-522). Below the layout breakpoint the
 * trigger is the avatar alone — `isCompact` drops the name and the role, and the
 * chevron goes with them — but it never disappears: it is the only route to sign
 * out and to the theme, and a bar that drops that at a width sends the reader
 * hunting for a control that is not there.
 */
export function PrincipalMenu({
  principal,
  children,
}: {
  principal: SessionPrincipal;
  /** Theme toggle, role stub, sign out — whatever the layout composed. */
  children?: ReactNode;
}) {
  const content = useContent();

  return (
    <MenuButton
      accessibleName={content.nav.accountLabel}
      triggerClassName={styles.trigger}
      label={
        <>
          <PrincipalIdentity principal={principal} isCompact />
          <Icon name="chevronDown" size="sm" className={styles.chevron} />
        </>
      }
    >
      <div className={styles.panel}>{children}</div>
    </MenuButton>
  );
}
