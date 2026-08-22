import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { CannedResponsesSectionSkeleton } from '@/features/canned-responses/components/CannedResponsesSection';

/**
 * The route-level skeleton, composed from the page's own section skeleton in the
 * same stack with the same header, so arriving here does not reflow when the
 * real page lands.
 */
export default function SavedRepliesLoading() {
  return (
    <Stack gap="5">
      <PageHeader
        title={content.cannedResponses.title}
        subtitle={content.cannedResponses.subtitle}
      />
      <CannedResponsesSectionSkeleton />
    </Stack>
  );
}
