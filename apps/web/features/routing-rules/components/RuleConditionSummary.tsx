import type { RoutingCondition } from '@whatsappcrm/contracts';
import { useContent } from '@/lib/content';
import { describeCondition, type RoutingRuleVocabulary } from '../presentation';
import styles from './RuleConditionSummary.module.css';

/**
 * A rule's conditions as the sentence they add up to. Usage:
 * `<RuleConditionSummary conditions={rule.conditions} vocabulary={vocabulary} />`.
 *
 * A list rather than one joined sentence, because the conditions combine with AND
 * and a bulleted list says that without a word — and stays readable at 320px,
 * where a four-clause sentence would not.
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
    <ul className={styles.list}>
      {conditions.map((condition, index) => (
        // Conditions carry no id of their own, and this list is read-only — it is
        // never reordered or filtered, so an index names the same clause every render.
        <li key={index} className={styles.item}>
          {describeCondition(condition, vocabulary, content)}
        </li>
      ))}
    </ul>
  );
}
