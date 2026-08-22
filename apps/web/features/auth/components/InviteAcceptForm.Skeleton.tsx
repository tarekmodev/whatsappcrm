import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { AUTH_POLICY } from '@whatsappcrm/contracts';
import { SkeletonBlock, SkeletonForText, SkeletonLine } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { cx } from '@/lib/cx';
import { AuthCard } from './AuthCard';
import { InvitePreviewSkeleton } from './InvitePreview';
import styles from './InviteAcceptForm.Skeleton.module.css';

/**
 * Stands in for the whole invite-accept card — the summary and the form — while
 * the token is read out of the fragment and looked up. Colocated with both, and
 * changed in the same commit when either changes.
 *
 * It mirrors the real card exactly: the same title and description, the same
 * summary block, the required legend, three fields with the hints and the policy
 * checklist the real ones carry, the same full-width action and the same footer
 * link. Measured rather than eyeballed — the loading and loaded cards come out
 * the same height, so the swap moves nothing.
 *
 * Shown immediately rather than after an anti-flash delay: this is the screen's
 * first paint, so delaying it would show an empty card instead of a faster one.
 * The delay rule is about swapping content that is already on screen.
 */
export function InviteAcceptSkeleton() {
  return (
    <AuthCard title={content.auth.inviteTitle} description={content.auth.inviteDescription}>
      <LoadingAnnouncement label={content.auth.inviteLoading} />
      <InvitePreviewSkeleton />
      <Stack gap="4">
        <span className={styles.legend}>
          <SkeletonForText>{content.form.requiredLegend}</SkeletonForText>
        </span>
        {PLACEHOLDER_FIELDS.map(({ label, hint, hasRequirements }) => (
          <Stack key={label} gap="2">
            <span className={cx(styles.line, styles.label)}>
              <SkeletonLine width={label} />
            </span>
            {/* `Field` renders its hint above the control, so this does too — and
                from the hint's own copy, because both of these wrap to a second
                line on a phone and one line on a laptop. */}
            {hint === undefined ? null : (
              <span className={styles.hint}>
                <SkeletonForText>{hint}</SkeletonForText>
              </span>
            )}
            <SkeletonBlock height="var(--size-touch-target)" />
            {/* And the checklist below it, one line per rule, from the same copy
                for the same reason. */}
            {hasRequirements ? (
              <span className={styles.requirements}>
                {PASSWORD_REQUIREMENTS.map((requirement) => (
                  <span key={requirement} className={cx(styles.line, styles.requirement)}>
                    <SkeletonForText>{requirement}</SkeletonForText>
                  </span>
                ))}
              </span>
            ) : null}
          </Stack>
        ))}
        <SkeletonBlock height="var(--size-touch-target)" />
        <span className={styles.footer}>
          <SkeletonLine width="8rem" />
        </span>
      </Stack>
    </AuthCard>
  );
}

/**
 * One entry per field the real form renders, in order. The label is a width —
 * a single word or two, which never wraps — and the hint is the copy itself, so
 * the placeholder occupies exactly the lines the real hint will.
 */
const PLACEHOLDER_FIELDS = [
  { label: '5rem', hint: content.auth.inviteDisplayNameHint, hasRequirements: false },
  { label: '9rem', hint: undefined, hasRequirements: true },
  { label: '11rem', hint: undefined, hasRequirements: false },
] as const;

/** The same two rules `PasswordRequirements` derives from the same policy. */
const PASSWORD_REQUIREMENTS = [
  content.auth.passwordMinRequirement(AUTH_POLICY.passwordMinLength),
  content.auth.passwordMaxRequirement(AUTH_POLICY.passwordMaxLength),
] as const;
