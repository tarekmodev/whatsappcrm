import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { PeopleSectionsSkeleton } from '@/features/people/components/PeopleSections';

/**
 * The route-level skeleton. Composed from the page's own section skeletons in the
 * same stack, with the same header, so navigating to People does not reflow when
 * the real page arrives.
 */
export default function PeopleLoading() {
  return (
    <Stack gap="5">
      <PageHeader title={content.people.title} subtitle={content.people.subtitle} />
      <PeopleSectionsSkeleton />
    </Stack>
  );
}
