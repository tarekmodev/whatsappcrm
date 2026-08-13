'use client';

import { useState } from 'react';
import type { AssignmentRuleResponse } from '@whatsappcrm/contracts';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingAnnouncement } from '@/components/ui/LoadingAnnouncement';
import { SkeletonLine, SkeletonText } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { useContent } from '@/lib/content';
import { ROUTING_RULES_SKELETON_COUNT } from '../constants';
import { movedRuleIds, type RoutingRuleVocabulary, type RuleMoveDirection } from '../presentation';
import { reorderRoutingRulesAction, setRoutingRuleActiveAction } from '../routing-rules.actions';
import { RoutingRuleCard } from './RoutingRuleCard';
import { LazyDeleteRuleDialog, LazyRuleFormDialog } from './rule-dialogs.lazy';
import cardStyles from './RoutingRuleCard.module.css';
import styles from './RoutingRulesList.module.css';

/**
 * The rules in evaluation order, and the dialogs the row actions open. Usage:
 * `<RoutingRulesList rules={rules} vocabulary={vocabulary} canWrite />`.
 *
 * An ordered list rather than a table: the order *is* the meaning here, `<ol>`
 * says so to a screen reader without a column for it, and a rule's conditions do
 * not fit a cell at 320px.
 *
 * Reordering and the on/off switch write straight through — no optimistic update.
 * Both are one round trip, both can be refused (a reorder loses to a concurrent
 * edit; enabling needs a target), and an optimistic reorder that rolled back
 * would show the supervisor an order that is not the one being evaluated. The
 * server action revalidates this route, so the list re-renders from the API.
 */
export function RoutingRulesList({
  rules,
  vocabulary,
  canWrite,
}: {
  rules: readonly AssignmentRuleResponse[];
  vocabulary: RoutingRuleVocabulary;
  canWrite: boolean;
}) {
  const content = useContent();
  const copy = content.routingRules;
  const { showToast } = useToast();
  const [editing, setEditing] = useState<AssignmentRuleResponse | null>(null);
  const [deleting, setDeleting] = useState<AssignmentRuleResponse | null>(null);
  /** The rule a write is in flight for, so only its own controls show pending. */
  const [pendingRuleId, setPendingRuleId] = useState<string | null>(null);

  /**
   * The write-toast-settle sequence the two inline actions share. A failure comes
   * back as a value, so it is shown as a toast rather than thrown into the
   * section's error boundary — a refused reorder should not blank the list.
   */
  async function runOnRule(
    rule: AssignmentRuleResponse,
    perform: () => Promise<ActionResult<unknown>>,
    describeSuccess: () => string,
  ): Promise<void> {
    setPendingRuleId(rule.id);

    try {
      const result = await perform();

      showToast(
        result.status === 'success'
          ? { tone: 'success', message: describeSuccess() }
          : { tone: 'danger', message: result.message },
      );
    } finally {
      setPendingRuleId(null);
    }
  }

  function move(rule: AssignmentRuleResponse, direction: RuleMoveDirection): void {
    // A second move started before the first came back would be computed from the
    // pre-move order, and the endpoint cannot catch it: both payloads carry the
    // same members, so its concurrency check passes both and the later write
    // silently undoes the earlier one. The cards disable the controls too; this is
    // the guard that does not depend on them.
    if (pendingRuleId !== null) {
      return;
    }

    const ruleIds = movedRuleIds(
      rules.map((current) => current.id),
      rule.id,
      direction,
    );

    // `null` means the rule is already at that end, which the card's disabled
    // control should have prevented — sending the unchanged order would be a
    // write that does nothing.
    if (ruleIds === null) {
      return;
    }

    void runOnRule(
      rule,
      () => reorderRoutingRulesAction({ ruleIds: [...ruleIds] }),
      () => copy.reorderSuccess,
    );
  }

  function toggle(rule: AssignmentRuleResponse): void {
    void runOnRule(
      rule,
      () => setRoutingRuleActiveAction(rule.id, !rule.isActive),
      () => (rule.isActive ? copy.disableSuccess(rule.name) : copy.enableSuccess(rule.name)),
    );
  }

  if (rules.length === 0) {
    return <EmptyState heading={copy.emptyHeading} body={copy.emptyBody} />;
  }

  return (
    <>
      <ol className={styles.list} aria-label={copy.listLabel}>
        {rules.map((rule, index) => (
          <RoutingRuleCard
            key={rule.id}
            rule={rule}
            position={index + 1}
            vocabulary={vocabulary}
            canWrite={canWrite}
            isFirst={index === 0}
            isLast={index === rules.length - 1}
            isPending={pendingRuleId === rule.id}
            isReordering={pendingRuleId !== null}
            onMove={(direction) => {
              move(rule, direction);
            }}
            onToggle={() => {
              toggle(rule);
            }}
            onEdit={() => {
              setEditing(rule);
            }}
            onDelete={() => {
              setDeleting(rule);
            }}
          />
        ))}
      </ol>

      {editing === null ? null : (
        <LazyRuleFormDialog
          rule={editing}
          vocabulary={vocabulary}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}

      {deleting === null ? null : (
        <LazyDeleteRuleDialog
          rule={deleting}
          onClose={() => {
            setDeleting(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Mirrors the loaded list: the same `<ol>`, the same card frame and spacing, a
 * name line, two summary lines and a target line — so the swap to real rules
 * shifts nothing. The action row is included only where the role will get one.
 */
export function RoutingRulesListSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  const content = useContent();

  return (
    <>
      <LoadingAnnouncement label={content.routingRules.loading} />
      <ol className={styles.list}>
        {Array.from({ length: ROUTING_RULES_SKELETON_COUNT }, (_unused, index) => (
          <li key={index} className={cardStyles.card} aria-hidden="true">
            <SkeletonLine width="5rem" height="var(--font-size-caption)" />
            <SkeletonLine width="12rem" height="1.125rem" />
            <SkeletonText lines={2} />
            <SkeletonLine width="9rem" />
            {hasActions ? <SkeletonLine height="var(--size-touch-target)" /> : null}
          </li>
        ))}
      </ol>
    </>
  );
}
