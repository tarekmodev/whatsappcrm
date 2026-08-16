import type { Permission } from '@whatsappcrm/contracts';
import { Stack } from '@/components/layout/Stack';
import { LazyBoundary } from '@/components/ui/LazyBoundary';
import type { PermissionChecker } from '@/lib/session/permissions';
import { loadContactProfile } from '../contacts.data';
import { ContactIdentityCard } from './ContactIdentityCard';
import { ContactIdentityCardSkeleton } from './ContactIdentityCard.Skeleton';
import { ContactCustomFieldsCardSkeleton } from './ContactCustomFieldsCard.Skeleton';
import { ContactTagsCardSkeleton } from './ContactTagsCard.Skeleton';
import { ContactUnavailable } from './ContactUnavailable';
import { LazyContactCustomFieldsCard, LazyContactTagsCard } from './contact-cards.lazy';

/**
 * Fetches one contact and composes the profile. Usage: inside a Suspense
 * boundary on the contact page, keyed on the id, with
 * `ContactProfileSectionSkeleton` as the fallback.
 *
 * A server component, so the read, the tenant scoping and both permission
 * decisions happen on the server and the client bundle carries none of them.
 *
 * The `can*` flags only decide what is *rendered*. The server action asserts
 * `contact:write` again, and the API a third time — a hidden control is UX, not
 * a gate.
 */

/** The permissions this surface's controls are gated on, named once. */
export const CONTACT_PERMISSIONS = {
  edit: 'contact:write',
  /**
   * What it takes to reach the screen that *defines* a custom field, so the
   * empty state can offer a link to it rather than telling an agent to go
   * somewhere they would be refused.
   */
  manageDefinitions: 'tenant:settings',
} as const satisfies Record<string, Permission>;

export async function ContactProfileSection({
  contactId,
  checker,
}: {
  contactId: string;
  checker: PermissionChecker;
}) {
  const profile = await loadContactProfile(contactId);

  if (profile.status === 'unavailable') {
    return <ContactUnavailable />;
  }

  const canWrite = checker.can(CONTACT_PERMISSIONS.edit);
  const canManageDefinitions = checker.can(CONTACT_PERMISSIONS.manageDefinitions);

  return (
    <Stack gap="5">
      <ContactIdentityCard contact={profile.contact} />

      {/* Not deferred: on a phone the tag editor is the next thing below the
          fold and an agent scrolls to it immediately. The split still keeps the
          chunk off every other route. */}
      <LazyBoundary fallback={<ContactTagsCardSkeleton canWrite={canWrite} />}>
        <LazyContactTagsCard contact={profile.contact} tags={profile.tags} canWrite={canWrite} />
      </LazyBoundary>

      {/* Deferred until visible: it is the last card, it pulls in every control
          type, and its skeleton occupies the same box either way — so waiting
          for the scroll costs nothing and shifts nothing. */}
      <LazyBoundary
        deferUntilVisible
        fallback={<ContactCustomFieldsCardSkeleton canWrite={canWrite} />}
      >
        <LazyContactCustomFieldsCard
          contact={profile.contact}
          definitions={profile.definitions}
          canWrite={canWrite}
          canManageDefinitions={canManageDefinitions}
        />
      </LazyBoundary>
    </Stack>
  );
}

/**
 * The fallback. The same stack and gap and the same three cards, each holding
 * its own section's skeleton, so the page does not reflow when the data lands.
 *
 * `canWrite` defaults to `true` here and in the route's `loading.tsx`, which has
 * no session to read: every role in today's table holds `contact:write`, so the
 * common path is exact and the read-only variant is one row taller for the
 * moment the skeleton is on screen.
 *
 * Changed in the same commit as the sections it stands in for.
 */
export function ContactProfileSectionSkeleton({ canWrite = true }: { canWrite?: boolean }) {
  return (
    <Stack gap="5">
      <ContactIdentityCardSkeleton />
      <ContactTagsCardSkeleton canWrite={canWrite} />
      <ContactCustomFieldsCardSkeleton canWrite={canWrite} />
    </Stack>
  );
}
