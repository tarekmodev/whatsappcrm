import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { TicketQueueFilters } from '@/features/tickets/components/TicketQueueFilters';
import { TicketQueueSectionSkeleton } from '@/features/tickets/components/TicketQueueSection';

/**
 * Route-level skeleton, composed from the page's own section skeleton and the
 * same frame.
 *
 * The filter bar is the real one, not a placeholder: it renders from constants,
 * so there is nothing about it to wait for, and drawing a skeleton over
 * something already known would be slower *and* emptier. It defaults to the view
 * an unparameterised arrival lands on.
 *
 * `canReadAll` is `false` because the permission is not resolved this early, and
 * offering a supervisor-only scope for the half-second before the page arrives
 * would be a link to an empty list.
 */
export default function TicketsLoading() {
  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.tickets.title} subtitle={content.tickets.subtitle} />
        <TicketQueueFilters
          params={{
            scope: 'assigned',
            status: undefined,
            priority: undefined,
            isOverdueOnly: false,
          }}
          canReadAll={false}
        />
        <TicketQueueSectionSkeleton />
      </Stack>
    </PageShell>
  );
}
