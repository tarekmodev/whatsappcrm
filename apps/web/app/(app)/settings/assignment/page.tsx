import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { requireAnyPermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  AssignmentSections,
  AssignmentSectionsSkeleton,
} from '@/features/assignment/components/AssignmentSections';
import {
  FlaggedTicketsSection,
  FlaggedTicketsSectionSkeleton,
} from '@/features/assignment/components/FlaggedTicketsSection';
import { parseDeferredReason } from '@/features/assignment/flagged-filters';
import {
  RoutingRulesPanel,
  RoutingRulesPanelSkeleton,
} from '@/features/routing-rules/components/RoutingRulesPanel';

/**
 * The supervisor's routing and reporting view. Composition only.
 *
 * Gated on `report:read_all` / `assignment_rule:read`, which the contract's
 * role table grants to supervisor and admin but not to agent — so this is exactly
 * TAR-22's third acceptance criterion, and an agent reaching the URL gets a 403
 * state rather than a tenant-wide report.
 *
 * **Three sections, gated separately and streamed separately**, because they are
 * three independent reads and one being slow or broken must not blank the others:
 *
 *   * the flagged queue (TAR-23) needs `ticket:read_all` — it is a tenant-wide
 *     ticket read, and a principal without it sees no empty frame promising a
 *     queue they cannot be shown;
 *   * routing rules (TAR-24) need `assignment_rule:read` specifically (0007's
 *     security section: not `channel:manage`, which is admin-only and would take
 *     routing out of a supervisor's hands);
 *   * the workload report is what `report:read_all` buys.
 *
 * So a principal holding only one of them gets that one, rather than a surface
 * they cannot use.
 */

export const metadata: Metadata = {
  title: content.assignment.title,
  description: content.assignment.subtitle,
};

/** Per-principal figures from a live session; nothing here is cacheable. */
export const dynamic = 'force-dynamic';

const ASSIGNMENT_PERMISSIONS = ['report:read_all', 'assignment_rule:read'] as const;

export default async function AssignmentPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const session = await requireAnyPermission(ASSIGNMENT_PERMISSIONS);

  if (session === null) {
    return <ForbiddenState />;
  }

  const params = await searchParams;
  const filters = {
    deferredReason: parseDeferredReason(firstSearchParam(params[searchParamKeys.assignmentReason])),
  };
  const canAssign = session.checker.can('ticket:assign');
  const canReadRules = session.checker.can('assignment_rule:read');
  // The same permission that writes a routing rule, and deliberately so: setting
  // how much work reaches a colleague is the same kind of act (ADR 0008
  // decision 4, TAR-384). Never `user:update`.
  const canEditCapacity = session.checker.can('assignment_rule:write');

  return (
    <Stack gap="5">
      <PageHeader title={content.assignment.title} subtitle={content.assignment.subtitle} />

      {session.checker.can('ticket:read_all') ? (
        <SectionErrorBoundary>
          {/* Keyed on the filter so changing it shows the skeleton again rather
              than leaving the previous reason's rows on screen. */}
          <Suspense
            key={filters.deferredReason ?? ''}
            fallback={
              <FlaggedTicketsSectionSkeleton hasRowActions={canAssign || canEditCapacity} />
            }
          >
            <FlaggedTicketsSection
              filters={filters}
              canAssign={canAssign}
              canEditCapacity={canEditCapacity}
            />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}

      {canReadRules ? (
        <SectionErrorBoundary>
          <Suspense fallback={<RoutingRulesPanelSkeleton />}>
            <RoutingRulesPanel canWrite={session.checker.can('assignment_rule:write')} />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}

      <SectionErrorBoundary>
        <Suspense fallback={<AssignmentSectionsSkeleton />}>
          <AssignmentSections />
        </Suspense>
      </SectionErrorBoundary>
    </Stack>
  );
}
