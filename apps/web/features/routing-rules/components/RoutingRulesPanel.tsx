import { loadRoutingRules } from '../routing-rules.data';
import { RoutingRulesSection, RoutingRulesSectionSkeleton } from './RoutingRulesSection';

/**
 * Fetches the rules and their vocabulary, then hands both to the section. Usage:
 * inside its own Suspense boundary on the Assignment page, with
 * `RoutingRulesPanelSkeleton` as the fallback.
 *
 * A server component, so five API reads and the permission decision happen on the
 * server and the client bundle carries neither. Its own boundary, separate from
 * the workload report's: the two are unrelated reads, and a slow report should not
 * hold the rule list back — nor take it down with it.
 */
export async function RoutingRulesPanel({ canWrite }: { canWrite: boolean }) {
  const { rules, vocabulary } = await loadRoutingRules();

  return <RoutingRulesSection rules={rules} vocabulary={vocabulary} canWrite={canWrite} />;
}

export function RoutingRulesPanelSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  return <RoutingRulesSectionSkeleton hasActions={hasActions} />;
}
