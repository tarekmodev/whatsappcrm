import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import { loadCannedResponses } from '../canned-responses.data';
import { CannedResponsesPanel } from './CannedResponsesPanel';
import { CannedResponsesTableSkeleton } from './CannedResponsesTable.Skeleton';

/**
 * Fetches the tenant's saved replies and hands them to the panel. Usage: inside
 * a Suspense boundary on the saved-replies settings page, with
 * `CannedResponsesSectionSkeleton` as the fallback.
 *
 * A server component, so the read happens on the server and the client bundle
 * carries neither it nor the permission decision above it. The panel owns the
 * card frame, because the create trigger lives in the card's action slot and
 * needs client state.
 */
export async function CannedResponsesSection({ canManage }: { canManage: boolean }) {
  const responses = await loadCannedResponses();

  return <CannedResponsesPanel responses={responses} canManage={canManage} />;
}

/**
 * The same `SectionCard` frame with the table's own skeleton inside it, so
 * nothing reflows when the replies land.
 *
 * No description here: it counts the replies, which is data that has not
 * arrived, and a placeholder line would be a guess at a string this skeleton
 * could know only by inventing a number.
 *
 * `canManage` defaults to `true` — the route's `loading.tsx` has no session to
 * read, and the page is already gated on `canned_response:write`, so everybody
 * who ever sees this skeleton can manage.
 *
 * Changed in the same commit as the panel it stands in for.
 */
export function CannedResponsesSectionSkeleton({ canManage = true }: { canManage?: boolean }) {
  return (
    <SectionCard id="saved-replies" title={content.cannedResponses.listHeading}>
      <CannedResponsesTableSkeleton canManage={canManage} />
    </SectionCard>
  );
}
