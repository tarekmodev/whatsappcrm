import type { RoutingCondition } from '@whatsappcrm/contracts';
import { ClauseList } from '@/components/ui/ClauseList';
import { useContent } from '@/lib/content';
import { describeCondition, type RoutingRuleVocabulary } from '../presentation';

/**
 * A rule's conditions as the sentence they add up to. Usage:
 * `<RuleConditionSummary conditions={rule.conditions} vocabulary={vocabulary} />`.
 *
 * The list shape is `ClauseList`, shared with the workflow card, which says the
 * same thing about its own conditions and actions. This module keeps only the
 * part that is routing's: turning one condition into the clause a supervisor
 * reads.
 */
export function RuleConditionSummary({
  conditions,
  vocabulary,
}: {
  conditions: readonly RoutingCondition[];
  vocabulary: RoutingRuleVocabulary;
}) {
  const content = useContent();

  return (
    <ClauseList
      clauses={conditions.map((condition) => describeCondition(condition, vocabulary, content))}
    />
  );
}
