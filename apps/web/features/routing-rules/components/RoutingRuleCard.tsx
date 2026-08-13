'use client';

import type { AssignmentRuleResponse } from '@whatsappcrm/contracts';
import { Cluster } from '@/components/layout/Cluster';
import { Stack } from '@/components/layout/Stack';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useContent } from '@/lib/content';
import {
  describeTarget,
  type RoutingRuleVocabulary,
  type RuleMoveDirection,
} from '../presentation';
import { RuleConditionSummary } from './RuleConditionSummary';
import styles from './RoutingRuleCard.module.css';

/**
 * One rule in the list: its place in the order, what it matches, where it routes,
 * and the controls that change any of that. Usage: rendered by `RoutingRulesList`
 * per rule.
 *
 * Every control is a real button with a name that includes the rule — "Move
 * Billing keywords earlier", not "Move up" — because a screen-reader user
 * tabbing a list of five rules hears the names, not the rows.
 *
 * `canWrite` removes the controls entirely rather than disabling them: a
 * supervisor with read-only access is shown the rules, not five dead buttons.
 */
export function RoutingRuleCard({
  rule,
  position,
  vocabulary,
  canWrite,
  isFirst,
  isLast,
  isPending,
  isReordering,
  onMove,
  onToggle,
  onEdit,
  onDelete,
}: {
  rule: AssignmentRuleResponse;
  /** One-based place in the evaluation order, shown to the user. */
  position: number;
  vocabulary: RoutingRuleVocabulary;
  canWrite: boolean;
  isFirst: boolean;
  isLast: boolean;
  /** True while any mutation on this rule is in flight. */
  isPending: boolean;
  /**
   * True while a write on *any* rule is in flight. A move is computed from the
   * order on screen, which does not update until revalidation lands, so a second
   * move started before the first returns would be computed from the stale order
   * and overwrite it. Every row's move controls stand down together.
   *
   * How they stand down differs by row, and that difference is a keyboard
   * concern rather than a visual one — see the move buttons below.
   */
  isReordering: boolean;
  onMove: (direction: RuleMoveDirection) => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const content = useContent();
  const copy = content.routingRules;
  const hasTarget = rule.target !== null;

  return (
    <li className={styles.card} data-inactive={rule.isActive ? undefined : 'true'}>
      <Cluster justify="between" align="start" gap="3">
        <div className={styles.identity}>
          <p className={styles.position}>{copy.orderPosition(position)}</p>
          <h3 className={styles.name}>{rule.name}</h3>
        </div>
        <Badge tone={rule.isActive ? 'success' : 'neutral'}>
          {rule.isActive ? copy.active : copy.inactive}
        </Badge>
      </Cluster>

      <Stack gap="2">
        <p className={styles.label}>{copy.conditionsHeading}</p>
        <RuleConditionSummary conditions={rule.conditions} vocabulary={vocabulary} />
      </Stack>

      <Stack gap="2">
        <p className={styles.label}>{copy.targetHeading}</p>
        <p className={styles.target} data-missing={hasTarget ? undefined : 'true'}>
          {describeTarget(rule.target, vocabulary, content)}
        </p>
      </Stack>

      {canWrite ? (
        <Cluster gap="2" className={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            // `isPending` rather than `disabled` on the row that was actually
            // clicked: `disabled` drops the button out of the tab order, so a
            // keyboard user who pressed this one would lose their place the
            // instant it fired. `Button` answers `isPending` with `aria-disabled`
            // and a click guard, which blocks the second press without moving
            // focus — the same trade the component makes for a pending submit.
            disabled={isFirst || (isReordering && !isPending)}
            isPending={isPending}
            aria-label={copy.moveUpAria(rule.name)}
            onClick={() => {
              onMove('up');
            }}
          >
            {copy.moveUp}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={isLast || (isReordering && !isPending)}
            isPending={isPending}
            aria-label={copy.moveDownAria(rule.name)}
            onClick={() => {
              onMove('down');
            }}
          >
            {copy.moveDown}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            // A rule with no target cannot be enabled: the API refuses it, and
            // `targetMissing` above already says what to do about it.
            disabled={!rule.isActive && !hasTarget}
            isPending={isPending}
            aria-label={rule.isActive ? copy.disableAria(rule.name) : copy.enableAria(rule.name)}
            onClick={onToggle}
          >
            {rule.isActive ? copy.disable : copy.enable}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label={copy.editRuleAria(rule.name)}
            onClick={onEdit}
          >
            {copy.editRule}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={copy.deleteRuleAria(rule.name)}
            onClick={onDelete}
          >
            {copy.deleteRule}
          </Button>
        </Cluster>
      ) : null}
    </li>
  );
}
