import { Stack } from '@/components/layout/Stack';
import { SectionCard } from '@/components/ui/SectionCard';
import { LazyBoundary } from '@/components/ui/LazyBoundary';
import { EmptyState } from '@/components/ui/EmptyState';
import { content } from '@/content/en';
import { loadAssignmentReport } from '../assignment.data';
import { AgentLoadTableSkeleton } from './AgentLoadTable';
import { TeamLoadTableSkeleton } from './TeamLoadTable';
import { LazyAgentLoadTable, LazyTeamLoadTable } from './assignment-widgets.lazy';

/**
 * The supervisor's reporting sections. Usage: inside a Suspense boundary on the
 * Assignment page, with `AssignmentSectionsSkeleton` as the fallback.
 *
 * Each table is its own lazy boundary with its own error boundary, so one failing
 * report does not take the other two down with it.
 */
export async function AssignmentSections() {
  const { agentRows, teamRows, unassigned } = await loadAssignmentReport();

  return (
    <Stack gap="5">
      <SectionCard
        id="unassigned"
        title={content.assignment.unassignedHeading}
        description={content.assignment.tenantScopeNotice}
      >
        {unassigned.length === 0 ? (
          <EmptyState
            heading={content.assignment.unassignedEmptyHeading}
            body={content.assignment.unassignedEmptyBody}
          />
        ) : (
          <p>{content.assignment.unassignedCount(unassigned.length)}</p>
        )}
      </SectionCard>

      <SectionCard id="agent-load" title={content.assignment.agentLoadHeading}>
        <LazyBoundary fallback={<AgentLoadTableSkeleton />} deferUntilVisible>
          <LazyAgentLoadTable rows={agentRows} />
        </LazyBoundary>
      </SectionCard>

      <SectionCard id="team-load" title={content.assignment.teamLoadHeading}>
        <LazyBoundary fallback={<TeamLoadTableSkeleton />} deferUntilVisible>
          <LazyTeamLoadTable rows={teamRows} />
        </LazyBoundary>
      </SectionCard>
    </Stack>
  );
}

/** Composed from the same three section frames and the tables' own skeletons. */
export function AssignmentSectionsSkeleton() {
  return (
    <Stack gap="5">
      <SectionCard
        id="unassigned"
        title={content.assignment.unassignedHeading}
        description={content.assignment.tenantScopeNotice}
      >
        <p aria-hidden="true">&nbsp;</p>
      </SectionCard>
      <SectionCard id="agent-load" title={content.assignment.agentLoadHeading}>
        <AgentLoadTableSkeleton />
      </SectionCard>
      <SectionCard id="team-load" title={content.assignment.teamLoadHeading}>
        <TeamLoadTableSkeleton />
      </SectionCard>
    </Stack>
  );
}
