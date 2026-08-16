import { Stack } from '@/components/layout/Stack';
import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';
import { listTenantDomains } from '@/lib/api/tenant';
import { DomainList } from './DomainList';
import { DomainSectionsSkeleton } from './DomainSections.Skeleton';

/**
 * The domains screen's one section.
 *
 * A server component: the list is read once on the server, so the settings page
 * stays composition only and no client bundle ships the read. The frame and the
 * heading are owned here rather than in the page, which is what lets the skeleton
 * beside this file reuse the identical frame.
 */
export async function DomainSections() {
  const domains = await listTenantDomains();

  return (
    <Stack gap="5">
      <SectionCard
        id="domains-list"
        title={content.domains.listHeading}
        description={content.domains.listDescription}
      >
        <DomainList domains={domains} />
      </SectionCard>
    </Stack>
  );
}

export { DomainSectionsSkeleton };
