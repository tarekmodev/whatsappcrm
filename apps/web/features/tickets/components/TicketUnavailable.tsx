import { EmptyState } from '@/components/ui/EmptyState';
import { TextLink } from '@/components/ui/TextLink';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';

/**
 * What a reader sees when the id names no ticket they may open. Usage: returned
 * from `TicketDetailSection` for the `unavailable` outcome.
 *
 * A real, explanatory state rather than the generic error card, because the API
 * answers `not_found` here by design — never `forbidden`, so nothing can be
 * enumerated across tenants or colleagues — and a Retry button on that answer
 * could never succeed. A supervisor sharing a queue link with an agent who
 * cannot see the ticket lands exactly here.
 */
export function TicketUnavailable() {
  return (
    <EmptyState
      heading={content.tickets.unavailableHeading}
      body={content.tickets.unavailableBody}
      action={<TextLink href={routes.tickets()}>{content.tickets.backToQueue}</TextLink>}
    />
  );
}
