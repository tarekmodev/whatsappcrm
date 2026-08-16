import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { CustomFieldsSectionSkeleton } from '@/features/custom-fields/components/CustomFieldsSection';

/**
 * The route-level skeleton, composed from the page's own section skeleton in the
 * same stack with the same header, so arriving here does not reflow when the
 * real page lands.
 */
export default function CustomFieldsLoading() {
  return (
    <Stack gap="5">
      <PageHeader title={content.customFields.title} subtitle={content.customFields.subtitle} />
      <CustomFieldsSectionSkeleton />
    </Stack>
  );
}
