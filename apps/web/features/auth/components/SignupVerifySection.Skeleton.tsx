import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import {
  SkeletonBlock,
  SkeletonCircle,
  SkeletonLine,
  SkeletonText,
} from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import styles from './SignupVerifySection.Skeleton.module.css';

/**
 * Stands in for whichever outcome card the verification turns out to be.
 * Colocated with `SignupVerifySection`, and changed in the same commit when it
 * changes.
 *
 * It mirrors the shape all four outcomes share — the icon disc, the heading, two
 * lines of body, a notice, and one full-width action — rather than any one of
 * them, because which one it will be is exactly what is not known yet. That is
 * what keeps the card from jumping when the answer arrives.
 *
 * ## Two waits, one shape
 *
 * `isProvisioning` distinguishes them for a screen reader only. Before the
 * request leaves, the wait is the token being read out of the URL fragment and
 * is over in an effect. After it, the wait is `POST /signup/verify` creating a
 * tenant, a schema, a first administrator and a session inside one transaction —
 * a budget of twenty seconds in the API, and long enough that "loading" would be
 * the wrong word for it.
 */
export function SignupVerifySkeleton({ isProvisioning = false }: { isProvisioning?: boolean }) {
  return (
    <section className={styles.card}>
      <LoadingAnnouncement
        label={isProvisioning ? content.auth.verifyPending : content.auth.verifyLoading}
      />
      <Stack gap="4">
        {/* The disc `AuthCard` draws an outcome's icon in, at the size it draws it. */}
        <SkeletonCircle size="var(--size-control-md)" />
        <span className={styles.title}>
          <SkeletonLine width="14rem" />
        </span>
        <SkeletonText lines={2} />
        {/* The `Notice` every outcome but one carries. */}
        <SkeletonBlock height="var(--space-8)" />
        <SkeletonBlock height="var(--size-touch-target)" />
      </Stack>
    </section>
  );
}
