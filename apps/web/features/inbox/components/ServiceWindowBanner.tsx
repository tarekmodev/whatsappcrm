'use client';

import { Notice } from '@/components/ui/Notice';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import type { ServiceWindow } from '@/features/inbox/service-window';
import styles from './MessageComposer.module.css';

/**
 * Whether this conversation still takes a free-form reply, and for how long.
 * Usage: `<ServiceWindowBanner window={window} />`.
 *
 * Above the composer rather than beside the Send button, because it changes what
 * the composer *is*: an agent who reads it after typing has already written a
 * message that cannot be sent. The countdown re-phrases on a timer so a banner
 * left open on a second monitor is not quietly an hour stale.
 *
 * The relative phrasing is `RelativeTime`'s — `Intl.RelativeTimeFormat`, one
 * implementation, and the absolute timestamp on hover for anyone who wants the
 * exact moment.
 */
export function ServiceWindowBanner({ window }: { window: ServiceWindow }) {
  const content = useContent();

  if (window.state === 'closed') {
    return (
      <Notice tone="warning">
        <Stack gap="1">
          <strong className={styles.bannerHeading}>{content.composer.windowClosedHeading}</strong>
          <span>{content.composer.windowClosedBody}</span>
        </Stack>
      </Notice>
    );
  }

  return (
    <Notice tone="info">
      <Stack gap="1">
        <span>
          {content.composer.windowOpenLabel}{' '}
          <RelativeTime
            isoTimestamp={window.expiresAt}
            label={content.composer.windowOpenLabel}
            refreshMs={COUNTDOWN_REFRESH_MS}
          />
        </span>
        <span>{content.composer.windowOpenNotice}</span>
      </Stack>
    </Notice>
  );
}

/**
 * Mirrors `ServiceWindowBanner`. Both of its states run to two lines inside the
 * same notice frame, so one reserved height is honest for either — and the
 * skeleton does not have to guess which is about to arrive.
 */
export function ServiceWindowBannerSkeleton() {
  return <SkeletonBlock height="var(--space-8)" className={styles.bannerSkeleton} />;
}

/**
 * Half a minute. The phrasing is in whole minutes at its finest, so anything
 * shorter re-renders without changing a character, and anything longer can show
 * "in 1 minute" after it has passed.
 */
const COUNTDOWN_REFRESH_MS = 30_000;
