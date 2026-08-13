import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { TextLink } from '@/components/ui/TextLink';
import { TicketDetailSectionSkeleton } from '@/features/tickets/components/TicketDetailSection';

/**
 * Route-level skeleton, composed from the page's own section skeleton and the
 * same frame — including the back link, which is a constant and has nothing to
 * wait for.
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
      </Stack>
    </PageShell>
  );
}
