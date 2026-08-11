import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { AssignmentSectionsSkeleton } from '@/features/assignment/components/AssignmentSections';

/** Route-level skeleton, composed from the page's own section skeletons. */
export default function AssignmentLoading() {
  return (
    <Stack gap="5">
      <PageHeader title={content.assignment.title} subtitle={content.assignment.subtitle} />
      <AssignmentSectionsSkeleton />
    </Stack>
  );
}
