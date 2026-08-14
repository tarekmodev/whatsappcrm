import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { AssignmentSectionsSkeleton } from '@/features/assignment/components/AssignmentSections';
import { RoutingRulesPanelSkeleton } from '@/features/routing-rules/components/RoutingRulesPanel';

/**
 * Route-level skeleton, composed from the page's own section skeletons.
 *
 * The rule panel is drawn unconditionally: this renders before the session is
 * resolved, so which half the principal will get is not knowable yet, and a
 * skeleton that guessed "no rules" would leave a gap that fills in a moment later.
 */
export default function AssignmentLoading() {
  return (
    <Stack gap="5">
      <PageHeader title={content.assignment.title} subtitle={content.assignment.subtitle} />
      <RoutingRulesPanelSkeleton />
      <AssignmentSectionsSkeleton />
    </Stack>
  );
}
