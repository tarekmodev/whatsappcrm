import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { TextLink } from '@/components/ui/TextLink';
import { TicketDetailSectionSkeleton } from '@/features/tickets/components/TicketDetailSection';
import { TicketHistorySectionSkeleton } from '@/features/tickets/components/TicketHistorySection';

/**
 * Route-level skeleton, composed from the page's own section skeletons and the
 * same frame — including the back link, which is a constant and has nothing to
 * wait for.
 *
 * Both sections are here because both are on the page: a route skeleton missing
 * one of them would reserve too little height and shift everything below it when
 * the second card arrived.
 */
export default function TicketLoading() {
  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader
          title={content.tickets.detailHeading}
          action={<TextLink href={routes.tickets()}>{content.tickets.backToQueue}</TextLink>}
        />
        <TicketDetailSectionSkeleton />
        <TicketHistorySectionSkeleton />
      </Stack>
    </PageShell>
  );
}
