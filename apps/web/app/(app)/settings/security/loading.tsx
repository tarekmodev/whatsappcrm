import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { SecuritySectionsSkeleton } from '@/features/auth/components/SecuritySections';

/**
 * The route-level skeleton. Composed from the page's own section skeleton in the
 * same stack, with the same header, so arriving at Security does not reflow when
 * the real page lands.
 */
export default function SecurityLoading() {
  return (
    <Stack gap="5">
      <PageHeader title={content.auth.securityTitle} subtitle={content.auth.securitySubtitle} />
      <SecuritySectionsSkeleton />
    </Stack>
  );
}
