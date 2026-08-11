import { SectionCard } from '@/components/ui/SectionCard';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonBlock, SkeletonLine } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { ChangePasswordForm } from './ChangePasswordForm';

/**
 * The Security page's sections. One for now — the password form — with the frame
 * and the heading owned here rather than in the page, so the page stays
 * composition only and the skeleton below can reuse the identical frame.
 *
 * The natural second section is the caller's live sessions
 * (`GET /api/v1/auth/sessions`, in the contract, endpoint not yet built): "signed
 * in on these devices, drop that one". It belongs on this page and slots in
 * beside this one without touching the page file.
 */
export function SecuritySections({ email }: { email: string }) {
  return (
    <Stack gap="5">
      <SectionCard
        id="change-password"
        title={content.auth.changeHeading}
        description={content.auth.changeDescription}
      >
        <ChangePasswordForm email={email} />
      </SectionCard>
    </Stack>
  );
}

/**
 * Mirrors `SecuritySections` — same stack, same card, same three fields and the
 * same full-width action — so the route's `loading.tsx` hands over to the real
 * page without the card changing height.
 *
 * Changed in the same commit as the component it stands in for. A skeleton that
 * has drifted is a bug, not a cosmetic issue.
 */
export function SecuritySectionsSkeleton() {
  return (
    <Stack gap="5">
      <SectionCard
        title={content.auth.changeHeading}
        description={content.auth.changeDescription}
      >
        <LoadingAnnouncement label={content.auth.securityLoading} />
        <Stack gap="4">
          <SkeletonField hasHint={false} />
          <SkeletonField hasHint />
          <SkeletonField hasHint={false} />
          <SkeletonBlock height="var(--size-touch-target)" />
        </Stack>
      </SectionCard>
    </Stack>
  );
}

/**
 * One `Field`'s worth of placeholder, in `Field`'s own order: label, then hint,
 * then control. Same `Stack gap` as `Field`'s rule, so the rhythm matches.
 */
function SkeletonField({ hasHint }: { hasHint: boolean }) {
  return (
    <Stack gap="2">
      <SkeletonLine width="8rem" />
      {hasHint ? <SkeletonLine width="60%" height="var(--font-size-caption)" /> : null}
      <SkeletonBlock height="var(--size-touch-target)" />
    </Stack>
  );
}
