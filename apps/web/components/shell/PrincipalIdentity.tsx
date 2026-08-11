import type { SessionPrincipal } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import styles from './PrincipalIdentity.module.css';

/**
 * Who the top bar says you are. Usage: `<PrincipalIdentity principal={principal} />`.
 *
 * Name and role, not an account menu — the actions that would sit in one
 * (theme, sign out) are already beside it, and a menu holding two items is a
 * click somebody has to make for nothing.
 *
 * The workspace this sits in is not named here. The session contract carries a
 * `tenantId` and no tenant name (`packages/contracts/src/auth.ts`), and an
 * opaque id is worse than nothing; naming the workspace is part of TAR-29's
 * white-label branding.
 */
export function PrincipalIdentity({ principal }: { principal: SessionPrincipal }) {
  return (
    <div className={styles.identity}>
      {/* Spread rather than `charAt`, so a name starting outside the basic
          multilingual plane does not lose half its first character. */}
      <span className={styles.avatar} aria-hidden="true">
        {[...principal.displayName][0]}
      </span>
      <span className={styles.text}>
        <VisuallyHidden>{content.auth.signedInAs}</VisuallyHidden>
        <span className={styles.name}>{principal.displayName}</span>
        <span className={styles.role}>{content.roles[principal.role]}</span>
      </span>
    </div>
  );
}
