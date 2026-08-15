import type { TenantLifecycleResponse } from '@whatsappcrm/contracts';
import { DetailList, type DetailListItem } from '@/components/ui/DetailList';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useContent } from '@/lib/content';
import { isBannerStatus } from '../presentation';
import styles from './LifecycleBanner.module.css';

/**
 * The page-level warning for a workspace that is not simply running. Usage:
 * `<LifecycleBanner lifecycle={lifecycle} />` — renders nothing for a state that
 * needs no warning, so the caller needs no conditional of its own.
 *
 * `role="status"`, not `role="alert"`: the state was already true when the page
 * loaded, and an assertive live region would interrupt a screen-reader user
 * reading the heading to tell them something the page is about to say anyway.
 * `Notice` was the alternative and is a single paragraph — this needs a heading,
 * a body and a deadline, because "you are suspended" without "and your data goes
 * on the 14th" is the half of the message that matters least.
 *
 * The deadline is a `RelativeTime`, so the server renders a stable absolute
 * value and the client upgrades it after mount. Splicing a formatted date into
 * the sentence was the alternative: it cannot be translated, and it would put
 * date formatting in the content layer.
 */
export function LifecycleBanner({ lifecycle }: { lifecycle: TenantLifecycleResponse }) {
  const content = useContent();

  if (!isBannerStatus(lifecycle.status)) {
    return null;
  }

  const copy = content.workspace.banners[lifecycle.status];
  const items = deadlines(lifecycle, content);

  return (
    <section role="status" className={styles.banner} data-status={lifecycle.status}>
      <h2 className={styles.heading}>{copy.heading}</h2>
      <p className={styles.body}>{copy.body}</p>
      {items.length === 0 ? null : <DetailList items={items} />}
    </section>
  );
}

/**
 * The dates that are actually pending, in the order they fall.
 *
 * Both are read rather than derived from the status: a `suspended` workspace has
 * a `purgeAt` and no grace period, a `past_due` one has the reverse, and a
 * transition that has not written its timer yet has neither. Rendering a row for
 * a `null` would be an empty promise about when something happens.
 */
function deadlines(
  lifecycle: TenantLifecycleResponse,
  content: ReturnType<typeof useContent>,
): readonly DetailListItem[] {
  const items: DetailListItem[] = [];

  if (lifecycle.gracePeriodEndsAt !== null) {
    items.push({
      id: 'grace-period-ends-at',
      term: content.workspace.suspendsLabel,
      value: (
        <RelativeTime
          isoTimestamp={lifecycle.gracePeriodEndsAt}
          label={content.workspace.suspendsLabel}
        />
      ),
    });
  }

  if (lifecycle.purgeAt !== null) {
    items.push({
      id: 'purge-at',
      term: content.workspace.purgeLabel,
      value: <RelativeTime isoTimestamp={lifecycle.purgeAt} label={content.workspace.purgeLabel} />,
    });
  }

  return items;
}
