import { AUTH_POLICY } from '@whatsappcrm/contracts';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonBlock, SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { cx } from '@/lib/cx';
import { AuthCard } from './AuthCard';
import styles from './InviteAcceptForm.Skeleton.module.css';

/**
 * Stands in for `ResetPasswordForm` while the token is being read out of the URL
 * fragment. Colocated with it, and changed in the same commit when it changes.
 *
 * It mirrors the real form exactly: the same card, the same title, the required
 * legend, a field with the policy checklist under it, a second field without one,
 * and the same full-width action. Every line is boxed to `1lh` of the type it
 * replaces, so the card is the same height before and after the swap.
 *
 * The wait is short (one effect after hydration) but it is not nothing, and a
 * blank card during it would read as a broken link — which is the exact thing
 * this screen exists to be clear about.
 *
 * The line boxes come from the invite skeleton's module file rather than a second
 * copy of the same four rules: the two skeletons stand in for two forms built
 * from the same components, so a change to how a field is measured has to reach
 * both or neither.
 */
export function ResetPasswordFormSkeleton() {
  return (
    <AuthCard title={content.auth.resetTitle} description={content.auth.resetDescription}>
      <LoadingAnnouncement label={content.auth.resetLoading} />
      <Stack gap="4">
        <span className={styles.legend}>
          <SkeletonForText>{content.form.requiredLegend}</SkeletonForText>
        </span>
        <Stack gap="2">
          <span className={cx(styles.line, styles.label)}>
            <SkeletonLine width="7rem" />
          </span>
          <SkeletonBlock height="var(--size-touch-target)" />
          {/* `PasswordRequirements` renders below the control, one line per rule,
              from the same copy — so the placeholder wraps where the real one
              will. */}
          <span className={styles.requirements}>
            {PASSWORD_REQUIREMENTS.map((requirement) => (
              <span key={requirement} className={cx(styles.line, styles.requirement)}>
                <SkeletonForText>{requirement}</SkeletonForText>
              </span>
            ))}
          </span>
        </Stack>
        <Stack gap="2">
          <span className={cx(styles.line, styles.label)}>
            <SkeletonLine width="9rem" />
          </span>
          <SkeletonBlock height="var(--size-touch-target)" />
        </Stack>
        <SkeletonBlock height="var(--size-touch-target)" />
        <span className={styles.footer}>
          <SkeletonLine width="8rem" />
        </span>
      </Stack>
    </AuthCard>
  );
}

/** The same two rules `PasswordRequirements` derives from the same policy. */
const PASSWORD_REQUIREMENTS = [
  content.auth.passwordMinRequirement(AUTH_POLICY.passwordMinLength),
  content.auth.passwordMaxRequirement(AUTH_POLICY.passwordMaxLength),
] as const;
