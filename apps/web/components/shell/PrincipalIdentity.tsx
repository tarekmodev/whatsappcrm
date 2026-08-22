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
 * `isCompact` is the difference between those two: the bar has no room for a
 * name and a role below the layout breakpoint, and the drawer has nothing but
 * room. Which one applies is the caller's to say, because it is a fact about
 * where the identity is standing rather than about the identity.
 *
 * The workspace this sits in is not named here. The session contract carries a
 * `tenantId` and no tenant name (`packages/contracts/src/auth.ts`), and an
 * opaque id is worse than nothing; naming the workspace is part of TAR-29's
 * white-label branding.
 */
export function PrincipalIdentity({
  principal,
  isCompact = false,
}: {
  principal: SessionPrincipal;
  /** Avatar only below the layout breakpoint; name and role return above it. */
  isCompact?: boolean;
}) {
  return (
    <span className={styles.identity} data-compact={isCompact ? 'true' : undefined}>
      <Avatar name={principal.displayName} />
      <span className={styles.text}>
        <VisuallyHidden>{content.auth.signedInAs}</VisuallyHidden>
        <span className={styles.name}>{principal.displayName}</span>
        <span className={styles.role}>{content.roles[principal.role]}</span>
      </span>
    </span>
  );
}
