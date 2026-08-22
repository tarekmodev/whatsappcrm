import { EmptyState } from '@/components/ui/EmptyState';
import { TextLink } from '@/components/ui/TextLink';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';

/**
 * What a reader sees when the id names no contact they may open. Usage: returned
 * from `ContactProfileSection` for the `unavailable` outcome.
 *
 * A real, explanatory state rather than the generic error card, because the API
 * answers `not_found` here by design — never `forbidden`, so nothing can be
 * enumerated across tenants — and a Retry on that answer could never succeed.
 */
export function ContactUnavailable() {
  return (
    <EmptyState
      icon="warning"
      title={content.contacts.unavailableHeading}
      description={content.contacts.unavailableBody}
      action={<TextLink href={routes.contacts()}>{content.contacts.backToContacts}</TextLink>}
    />
  );
}
