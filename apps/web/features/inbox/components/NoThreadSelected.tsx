import { EmptyState } from '@/components/ui/EmptyState';
import { SectionCard } from '@/components/ui/SectionCard';
import { content } from '@/content/en';

/**
 * What the thread pane shows before a conversation is picked. Usage:
 * `<NoThreadSelected />` as the `thread` slot of `InboxPanes`.
 *
 * The same card frame the real thread uses, so choosing a conversation swaps
 * the contents rather than resizing the pane. It only ever appears at widths
 * where both panes are on screen — below that, no thread means the list is the
 * whole screen.
 */
export function NoThreadSelected() {
  return (
    <SectionCard id="conversation" title={content.inbox.threadHeading}>
      <EmptyState heading={content.inbox.noThreadHeading} body={content.inbox.noThreadBody} />
    </SectionCard>
  );
}
