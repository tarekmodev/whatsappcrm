'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Cluster } from '@/components/layout/Cluster';
import { Notice } from '@/components/ui/Notice';
import { useContent } from '@/lib/content';
import type { CapacityRemedy } from '../capacity';
import { LazyAgentCapacityDialog } from './flagged-dialogs.lazy';
import styles from './CapacityNotice.module.css';

/**
 * The remedy above the flagged queue: how many of these rows are stuck on a
 * limit, what changing one does, and the way to change it. Usage, between
 * `FilterPills` and the table:
 * `<CapacityNotice atCapacityCount={2} isFilteredToCapacity={false} remedy={remedy} />`.
 *
 * **Section-level rather than per-row** (TAR-755's panel 1, settled on TAR-778).
 * Raising a cap is not a per-ticket act: the same dialog with the same contents
 * would hang off every `all_at_capacity` row — up to a full page of identical
 * buttons doing one identical thing, with no subject to tell them apart, which
 * is also why the control's accessible name could not name its row. Putting it
 * in the actions column cost the table real width besides: a two-button cluster
 * on *some* rows widens the column on *every* row, so the primary verb stopped
 * holding a line down the page. Up here it costs the table nothing and can state
 * the aggregate fact, which is the thing that makes the remedy legible at all.
 *
 * A client component only because the button owns the dialog's open state; the
 * counts and the permission decision are both made on the server and passed in.
 *
 * Renders nothing when no row on the page is at capacity — on a queue stuck for
 * any other reason a higher limit changes nothing, and offering it would send a
 * supervisor to fix the wrong thing.
 */
export function CapacityNotice({
  atCapacityCount,
  isFilteredToCapacity,
  remedy,
}: {
  /** `all_at_capacity` rows **on this page**, from `countAtCapacity`. */
  atCapacityCount: number;
  /** True under the "Everyone at capacity" pill, where a count is a riddle. */
  isFilteredToCapacity: boolean;
  /** What this reader can do about it — see `capacityRemedy`. */
  remedy: CapacityRemedy;
}) {
  const content = useContent();
  const [isEditing, setIsEditing] = useState(false);

  if (atCapacityCount === 0) {
    return null;
  }

  /*
   * One sentence per remedy, keyed rather than nested ternaries: each absence has
   * its own reason and none of the three may borrow another's. A record indexed by
   * the union makes a fourth `kind` a type error here rather than a silent fall
   * through to the permitted copy.
   */
  const remedyCopy: Record<CapacityRemedy['kind'], string> = {
    edit: content.assignment.capacityNoticeConsequence,
    // Per 0001 the button is omitted rather than disabled, so the copy names who can act.
    denied: content.assignment.capacityNoticeAskSupervisor,
    // Permitted, but there is nothing to change from here — and no refresh to promise.
    unavailable: content.assignment.capacityNoticeUnavailable,
  };

  return (
    <>
      <Notice tone="warning" variant="quiet">
        <Cluster as="span" gap="3" justify="between" className={styles.row}>
          <span className={styles.copy}>
            <span className={styles.count}>
              {isFilteredToCapacity
                ? content.assignment.capacityNoticeCountFiltered
                : content.assignment.capacityNoticeCount(atCapacityCount)}
            </span>{' '}
            {/* The fact above holds for every reader; one sentence per remedy. */}
            <span>{remedyCopy[remedy.kind]}</span>
          </span>

          {remedy.kind === 'edit' ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setIsEditing(true);
              }}
            >
              {content.assignment.raiseLimit}
            </Button>
          ) : null}
        </Cluster>
      </Notice>

      {/* The chunk loads on first open, not with the page. */}
      {remedy.kind === 'edit' && isEditing ? (
        <LazyAgentCapacityDialog
          rows={remedy.report.rows}
          workspaceDefault={remedy.report.workspaceDefault}
          hasMore={remedy.report.hasMore}
          onClose={() => {
            setIsEditing(false);
          }}
        />
      ) : null}
    </>
  );
}
