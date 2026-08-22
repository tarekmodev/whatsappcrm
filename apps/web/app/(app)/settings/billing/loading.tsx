import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { BillingSectionsSkeleton } from '@/features/billing/components/BillingSections';

/**
 * The route-level skeleton. Composed from the page's own section skeleton in the
 * same stack, with the same header, so arriving here does not reflow when the
 * real page lands.
 */
export default function BillingSettingsLoading() {
  return (
    <Stack gap="5">
      <PageHeader title={content.billing.title} subtitle={content.billing.subtitle} />
      <BillingSectionsSkeleton />
    </Stack>
  );
}
