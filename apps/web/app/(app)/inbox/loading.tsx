import { content } from '@/content/en';
import { VisuallyHidden } from '@/components/layout/VisuallyHidden';
import { PageShell } from '@/components/shell/PageShell';
import { InboxFilterNav } from '@/features/inbox/components/InboxFilterNav';
import { InboxLayout } from '@/features/inbox/components/InboxLayout';
import { InboxSectionSkeleton } from '@/features/inbox/components/InboxSection';
import { NoThreadSelected } from '@/features/inbox/components/NoThreadSelected';

/**
 * Route-level skeleton, composed from the page's own section skeletons and the
 * same four-region workspace — including `variant="fill"`, so the frame the
 * agent waits in is the frame they end up in and the arrival shifts nothing.
 *
 * `hasThread` is `false` because `loading.tsx` renders before the search
 * parameters are read: the list is what every arrival at this route sees first,
 * and showing a thread skeleton for a URL that may not name one would be a
 * placeholder for something that is not coming. The context column follows the
 * thread, so it is absent for the same reason.
 *
 * The filter column is the real one, not a skeleton. It renders from a constant
 * — there is nothing about it to wait for — and drawing a placeholder over
 * something already known would be slower *and* emptier. It defaults to the
 * first filter's URL, which is where an unparameterised arrival lands anyway.
 */
export default function InboxLoading() {
  return (
    <PageShell variant="fill">
      <VisuallyHidden as="h1">{content.inbox.title}</VisuallyHidden>

      <InboxLayout
        hasThread={false}
        filters={
          <InboxFilterNav
            scope="assigned"
            status={undefined}
            conversationId={null}
            // The permission is not resolved this early; the settings link is
            // one entry, and offering it here to somebody who may not hold
            // `channel:manage` for the half-second before the page arrives is
            // worse than leaving it to the page.
            canManageChannels={false}
          />
        }
        list={<InboxSectionSkeleton />}
        thread={<NoThreadSelected />}
        context={null}
      />
    </PageShell>
  );
}
