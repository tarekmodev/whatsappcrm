import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { searchParamKeys } from '@/lib/routes';
import { firstSearchParam, type RouteSearchParams } from '@/lib/search-params';
import { requirePermission } from '@/lib/session/session';
import { isTicketScopeNarrowed } from '@/lib/session/permissions';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import { TicketQueueFilters } from '@/features/tickets/components/TicketQueueFilters';
import {
  TicketQueueSection,
  TicketQueueSectionSkeleton,
} from '@/features/tickets/components/TicketQueueSection';
import { parseTicketQueueParams } from '@/features/tickets/ticket-params';

/**
 * The ticket queue. Composition only: gate, header, filters, and the queue
 * behind a Suspense boundary with its own skeleton.
 *
 * Scope, status and priority all live in the URL, so a refresh, a copied link
 * and the back button reproduce the same view.
 */

export const metadata: Metadata = {
  title: content.tickets.title,
  description: content.tickets.subtitle,
};

/**
 * Per-principal scoping from a live session, and refetch-on-view is how an
 * auto-reopen becomes visible (ADR 0006 §9). Nothing here is cacheable.
 */
export const dynamic = 'force-dynamic';

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const session = await requirePermission('ticket:read');

  if (session === null) {
    return <ForbiddenState />;
  }

  const params = await searchParams;
  const query = parseTicketQueueParams({
    scope: firstSearchParam(params[searchParamKeys.ticketScope]),
    status: firstSearchParam(params[searchParamKeys.ticketStatus]),
    priority: firstSearchParam(params[searchParamKeys.ticketPriority]),
    overdue: firstSearchParam(params[searchParamKeys.ticketOverdue]),
  });

  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.tickets.title} subtitle={content.tickets.subtitle} />

        <TicketQueueFilters params={query} canReadAll={session.checker.can('ticket:read_all')} />

        <SectionErrorBoundary>
          {/* Keyed on the filters so a filter change shows the skeleton again
              rather than leaving the previous scope's rows on screen. */}
          <Suspense
            key={`${query.scope}:${query.status ?? ''}:${query.priority ?? ''}:${String(query.isOverdueOnly)}`}
            fallback={<TicketQueueSectionSkeleton />}
          >
            <TicketQueueSection
              params={query}
              isScopeNarrowed={isTicketScopeNarrowed(session.checker, query.scope)}
            />
          </Suspense>
        </SectionErrorBoundary>
      </Stack>
    </PageShell>
  );
}
