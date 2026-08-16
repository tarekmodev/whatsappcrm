import { Suspense } from 'react';
import type { Metadata } from 'next';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { requirePermission } from '@/lib/session/session';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { ForbiddenState } from '@/components/ui/ForbiddenState';
import { TextLink } from '@/components/ui/TextLink';
import { SectionErrorBoundary } from '@/components/ui/SectionErrorBoundary';
import {
  TicketDetailSection,
  TicketDetailSectionSkeleton,
} from '@/features/tickets/components/TicketDetailSection';
import { TicketUnavailable } from '@/features/tickets/components/TicketUnavailable';
import { parseTicketId } from '@/features/tickets/ticket-params';

/**
 * One ticket: what it is, and the controls that change its status and priority.
 * Composition only.
 */

export const metadata: Metadata = {
  title: content.tickets.detailHeading,
  description: content.tickets.subtitle,
};

/** Per-principal, and refetch-on-view (ADR 0006 §9). Nothing here is cacheable. */
export const dynamic = 'force-dynamic';

export default async function TicketPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const session = await requirePermission('ticket:read');

  if (session === null) {
    return <ForbiddenState />;
  }

  const { ticketId: rawTicketId } = await params;
  // A segment that is not a UUID names no ticket. Answered with the same state a
  // ticket outside this reader's scope gets, rather than an error card: from the
  // reader's side a truncated link and an invisible ticket are the same event.
  const ticketId = parseTicketId(rawTicketId);

  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader
          title={content.tickets.detailHeading}
          action={<TextLink href={routes.tickets()}>{content.tickets.backToQueue}</TextLink>}
        />

        {ticketId === null ? (
          <TicketUnavailable />
        ) : (
          <SectionErrorBoundary>
            <Suspense key={ticketId} fallback={<TicketDetailSectionSkeleton />}>
              <TicketDetailSection ticketId={ticketId} />
            </Suspense>
          </SectionErrorBoundary>
        )}
      </Stack>
    </PageShell>
  );
}
