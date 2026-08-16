import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import { loadCustomFieldDefinitions } from '../custom-fields.data';
import { CustomFieldsPanel } from './CustomFieldsPanel';
import { CustomFieldsTableSkeleton } from './CustomFieldsTable.Skeleton';

/**
 * Fetches the tenant's contact schema and hands it to the panel. Usage: inside a
 * Suspense boundary on the custom-fields settings page, with
 * `CustomFieldsSectionSkeleton` as the fallback.
 *
 * A server component, so the read happens on the server and the client bundle
 * carries neither it nor the permission decision above it. The panel owns the
 * card frame, because the create trigger lives in the card's action slot and
 * needs client state.
 */
export async function CustomFieldsSection({ canManage }: { canManage: boolean }) {
  const definitions = await loadCustomFieldDefinitions();

  return <CustomFieldsPanel definitions={definitions} canManage={canManage} />;
}

/**
 * The same `SectionCard` frame with the table's own skeleton inside it, so
 * nothing reflows when the definitions land.
 *
 * No description here: it counts the fields, which is data that has not arrived,
 * and a placeholder line would be a guess at a string this skeleton could know
 * only by inventing a number.
 *
 * `canManage` defaults to `true` — the route's `loading.tsx` has no session to
 * read, and the page is already gated on `tenant:settings`, so everybody who
 * ever sees this skeleton can manage.
 *
 * Changed in the same commit as the panel it stands in for.
 */
export function CustomFieldsSectionSkeleton({ canManage = true }: { canManage?: boolean }) {
  return (
    <SectionCard id="custom-fields" title={content.customFields.listHeading}>
      <CustomFieldsTableSkeleton canManage={canManage} />
    </SectionCard>
  );
}
