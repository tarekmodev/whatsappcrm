import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonBlock, SkeletonLine } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { AuthCard } from './AuthCard';

/**
 * Stands in for `ResetPasswordForm` while the token is being read out of the URL
 * fragment. Colocated with it, and changed in the same commit when it changes.
 *
 * It mirrors the real form exactly: the same card, the same title, two fields
 * each with a label line and a control block, and the same full-width action. The
 * hint line under the first field is there because the real one has one — without
 * it the card grows by a line the moment the form arrives.
 *
 * The wait is short (one effect after hydration) but it is not nothing, and a
 * blank card during it would read as a broken link — which is the exact thing
 * this screen exists to be clear about.
 */
export function ResetPasswordFormSkeleton() {
  return (
    <AuthCard title={content.auth.resetTitle} description={content.auth.resetDescription}>
      <LoadingAnnouncement label={content.auth.resetLoading} />
      <Stack gap="4">
        <Stack gap="2">
          <SkeletonLine width="7rem" />
          {/* `Field` renders its hint above the control, so this does too. */}
          <SkeletonLine width="60%" height="var(--font-size-caption)" />
          <SkeletonBlock height="var(--size-touch-target)" />
        </Stack>
        <Stack gap="2">
          <SkeletonLine width="9rem" />
          <SkeletonBlock height="var(--size-touch-target)" />
        </Stack>
        <SkeletonBlock height="var(--size-touch-target)" />
      </Stack>
    </AuthCard>
  );
}
