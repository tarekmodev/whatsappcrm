import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { AssignmentSectionsSkeleton } from '@/features/assignment/components/AssignmentSections';
import { FlaggedTicketsSectionSkeleton } from '@/features/assignment/components/FlaggedTicketsSection';
import { RoutingRulesPanelSkeleton } from '@/features/routing-rules/components/RoutingRulesPanel';

/**
 * Route-level skeleton, composed from the page's own section skeletons, in the
 * order the page renders them.
 *
 * Both permission-gated sections are drawn unconditionally, for one reason: this
 * runs before the session is resolved, so which half the principal will get is not
 * knowable yet, and a skeleton that guessed would leave a gap that fills in a
 * moment later. The flagged queue's actions column follows from the same argument
 * — every role that can reach this route holds `ticket:assign`, and the
 * alternative is a column that appears on arrival.
 */
export default function AssignmentLoading() {
  return (
    <Stack gap="5">
      <PageHeader title={content.assignment.title} subtitle={content.assignment.subtitle} />
      <FlaggedTicketsSectionSkeleton />
      <RoutingRulesPanelSkeleton />
      <AssignmentSectionsSkeleton />
    </Stack>
  );
}
