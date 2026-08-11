'use client';

import type { InvitePreviewResponse } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonLine } from '@/components/ui/Skeleton';
import { useContent } from '@/lib/content';
import { cx } from '@/lib/cx';
import styles from './InvitePreview.module.css';

/**
 * What the invitation says, shown before the invitee types anything. Usage:
 * `<InvitePreview preview={preview} />`.
 *
 * Deliberately minimal, because `POST /invites/lookup` is: anybody holding a
 * random string can call it, so the response carries who invited them and to what
 * and nothing else — it must not become a tenant-enumeration oracle.
 *
 * The email address is display-only rather than an editable field. The invitation
 * is bound to that address on the server; letting somebody type a different one
 * would be a control that does nothing.
 */
export function InvitePreview({ preview }: { preview: InvitePreviewResponse }) {
  const content = useContent();

  return (
    <Stack gap="3">
      <p className={styles.lead}>
        {preview.invitedByName === null
          ? content.auth.invitedTo(preview.tenantName)
          : content.auth.invitedByTo(preview.invitedByName, preview.tenantName)}
      </p>

      <dl className={styles.list}>
        <div className={styles.row}>
          <dt className={styles.term}>{content.auth.emailLabel}</dt>
          <dd className={styles.value}>{preview.email}</dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.term}>{content.auth.inviteRoleLabel}</dt>
          <dd className={styles.value}>{content.roles[preview.role]}</dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.term}>{content.auth.inviteExpires}</dt>
          <dd className={styles.value}>
            <RelativeTime isoTimestamp={preview.expiresAt} label={content.auth.inviteExpiryLabel} />
          </dd>
        </div>
      </dl>
    </Stack>
  );
}

/**
 * The placeholder for the same block, in the same wrapper with the same gaps and
 * the same three rows — so the swap to real content moves nothing.
 */
export function InvitePreviewSkeleton() {
  return (
    <Stack gap="3">
      <span className={cx(styles.lead, styles.leadPlaceholder)}>
        <span className={styles.placeholderLine}>
          <SkeletonLine />
        </span>
        <span className={styles.placeholderLine}>
          <SkeletonLine width="62%" />
        </span>
      </span>

      <div className={styles.list}>
        {PLACEHOLDER_ROWS.map((width) => (
          <div key={width} className={styles.row}>
            <span className={cx(styles.term, styles.placeholderLine)}>
              <SkeletonLine width="6rem" />
            </span>
            <span className={cx(styles.value, styles.placeholderLine)}>
              <SkeletonLine width={width} />
            </span>
          </div>
        ))}
      </div>
    </Stack>
  );
}

/** One per row above, at roughly the width of the value it stands in for. */
const PLACEHOLDER_ROWS = ['11rem', '4rem', '7rem'] as const;
