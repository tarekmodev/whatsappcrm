import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageShell } from '@/components/shell/PageShell';
import { PageHeader } from '@/components/shell/PageHeader';
import { InboxPanes } from '@/features/inbox/components/InboxPanes';
import { InboxSectionSkeleton } from '@/features/inbox/components/InboxSection';
import { NoThreadSelected } from '@/features/inbox/components/NoThreadSelected';

/**
 * Route-level skeleton, composed from the page's own section skeletons and the
 * same two-pane frame.
 *
 * `hasThread` is `false` because `loading.tsx` renders before the search
 * parameters are read: the list is what every arrival at this route sees first,
 * and showing a thread skeleton for a URL that may not name one would be a
 * placeholder for something that is not coming.
 */
export default function InboxLoading() {
  return (
    <PageShell>
      <Stack gap="5">
        <PageHeader title={content.inbox.title} />
        <InboxPanes
          hasThread={false}
          list={<InboxSectionSkeleton />}
          thread={<NoThreadSelected />}
        />
      </Stack>
    </PageShell>
  );
}
