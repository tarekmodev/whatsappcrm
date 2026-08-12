import type { SessionPrincipal } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { Avatar } from '@/components/ui/Avatar';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import styles from './PrincipalIdentity.module.css';

/**
 * Who the top bar says you are: avatar, name and role. Usage:
 * `<PrincipalIdentity principal={principal} />`.
 *
 * Presentation only, and deliberately not a control — `PrincipalMenu` wraps it
 * as the label of the bar's account menu, and `MobileMenu` renders it flat in
 * the drawer, where the same actions are already listed below it.
 *
 * The workspace this sits in is not named here. The session contract carries a
 * `tenantId` and no tenant name (`packages/contracts/src/auth.ts`), and an
 * opaque id is worse than nothing; naming the workspace is part of TAR-29's
 * white-label branding.
 */
export function PrincipalIdentity({ principal }: { principal: SessionPrincipal }) {
  return (
    <span className={styles.identity}>
      <Avatar name={principal.displayName} />
      <span className={styles.text}>
        <VisuallyHidden>{content.auth.signedInAs}</VisuallyHidden>
        <span className={styles.name}>{principal.displayName}</span>
        <span className={styles.role}>{content.roles[principal.role]}</span>
      </span>
    </span>
  );
}
