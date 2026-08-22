'use client';

import { Icon } from '@/components/ui/Icon';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import type { ServiceWindow } from '@/features/inbox/service-window';
import styles from './ServiceWindowHint.module.css';

/**
 * Whether this conversation still takes a free-form reply, and for how long.
 * Usage: `<ServiceWindowHint window={window} />`, inline at the trailing edge of
 * the composer's toolbar.
 *
 * It was a two-line `Notice` above the reply box until TAR-518. That put a
 * saturated banner over every reply an agent wrote — the commonest state of the
 * commonest screen in the product — to say something that is, while the window is
 * open, a countdown and nothing else. Now the open state is one caption beside
 * Send and the closed state is the loud one, which is the right way round: only
 * one of them changes what the composer can do.
 *
 * The countdown re-phrases on a timer so a composer left open on a second
 * monitor is not quietly an hour stale. The relative phrasing is `RelativeTime`'s
 * — `Intl.RelativeTimeFormat`, one implementation, and the absolute timestamp on
 * hover for anyone who wants the exact moment.
 */
export function ServiceWindowHint({ window }: { window: ServiceWindow }) {
  const content = useContent();

  if (window.state === 'closed') {
    return (
      <p className={styles.hint} data-state="closed">
        <Icon name="warning" size="sm" />
        <span>
          <strong className={styles.heading}>{content.composer.windowClosedHeading}</strong>{' '}
          {content.composer.windowClosedBody}
        </span>
      </p>
    );
  }

  return (
    <p className={styles.hint} data-state="open">
      <Icon name="clock" size="sm" />
      <span>
        {content.composer.windowOpenLabel}{' '}
        <RelativeTime
          isoTimestamp={window.expiresAt}
          label={content.composer.windowOpenLabel}
          refreshMs={COUNTDOWN_REFRESH_MS}
        />
      </span>
    </p>
  );
}

/**
 * Mirrors the open state, which is the one a loading composer is overwhelmingly
 * about to show: a countdown's width, on the toolbar's own line.
 */
export function ServiceWindowHintSkeleton() {
  return <SkeletonLine width="10rem" />;
}

/**
 * Half a minute. The phrasing is in whole minutes at its finest, so anything
 * shorter re-renders without changing a character, and anything longer can show
 * "in 1 minute" after it has passed.
 */
const COUNTDOWN_REFRESH_MS = 30_000;
