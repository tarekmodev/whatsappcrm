import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { InboxSectionSkeleton } from '@/features/inbox/components/InboxSection';

/** Route-level skeleton, composed from the page's own section skeleton. */
export default function InboxLoading() {
  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.inbox.title} />
        <InboxSectionSkeleton />
      </Stack>
    </PageShell>
  );
}
