import { Suspense, type ReactNode } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import type { PermissionChecker } from '@/lib/session/permissions';
import { AddKnowledgeEntryAction } from './AddKnowledgeEntryAction';
import { KnowledgeFilterBarSkeleton } from './KnowledgeFilterBar.Skeleton';
import { KnowledgeDocumentsTableSkeleton } from './KnowledgeDocumentsTable';
import styles from './KnowledgeBaseSection.module.css';

/**
 * The knowledge base card: the frame, the `Add entry` action, and whatever the
 * page composes into it. Usage:
 * `<KnowledgeBaseSection checker={checker}><KnowledgeFilterSection …/><KnowledgeDocumentsPanel …/></KnowledgeBaseSection>`.
 *
 * A **server** component that awaits nothing (TAR-613). It used to be a client
 * component holding the add dialog's open state, and it used to receive the
 * documents as a prop. Both moved: the dialog into `AddKnowledgeEntryButton`,
 * the read into the page. What is left is a frame that renders synchronously —
 * which is what lets the filter bar and the table sit in two different Suspense
 * boundaries inside it, one unkeyed and one keyed, without either waiting on the
 * configuration.
 *
 * The card is where the filters live rather than above the page header: this
 * route has three cards and only one of them is a list, so a page-level filter
 * row would read as filtering the readiness panel and the settings form too.
 *
 * `children` sits in a single `Stack gap="4"` — bar, notice, table, one gap
 * between each. Neither child wraps itself in a stack of its own.
 */
export function KnowledgeBaseSection({
  checker,
  children,
}: {
  checker: PermissionChecker;
  children: ReactNode;
}) {
  return (
    <SectionCard
      id="knowledge-base"
      title={content.chatbot.knowledgeHeading}
      description={content.chatbot.knowledgeDescription}
      action={
        // The plan gate needs the configuration, and the frame must not wait for
        // it. A button-sized placeholder rather than nothing, so the card header
        // keeps its height and the affordance is visibly on its way.
        <Suspense fallback={<AddEntryActionSkeleton />}>
          <AddKnowledgeEntryAction checker={checker} />
        </Suspense>
      }
    >
      <Stack gap="4">{children}</Stack>
    </SectionCard>
  );
}

/**
 * The whole card as a placeholder, for the route-level `loading.tsx` where there
 * is no session to gate the action on and no filters to read.
 *
 * It draws the filter row, because that is what the page paints first: the bar's
 * own boundary shows its fallback on first mount whether or not the tenant turns
 * out to have entries, so leaving it out here would move the table when the page
 * takes over from the route skeleton.
 *
 * Row actions are assumed present for the same reason the workspace skeleton
 * always draws its plan card: this route's `loading.tsx` has no session to read,
 * and every principal who reaches this page under today's role table holds
 * `ai:write`.
 *
 * Changed in the same commit as the section it stands in for.
 */
export function KnowledgeBaseSectionSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  return (
    <SectionCard
      id="knowledge-base"
      title={content.chatbot.knowledgeHeading}
      description={content.chatbot.knowledgeDescription}
      action={<AddEntryActionSkeleton />}
    >
      <Stack gap="4">
        <KnowledgeFilterBarSkeleton />
        <KnowledgeDocumentsTableSkeleton hasActions={hasActions} />
      </Stack>
    </SectionCard>
  );
}

/**
 * A block the size of the `Add entry` button, so the card's header row does not
 * change height when the plan gate resolves. `--size-touch-target` is what
 * `Control.module.css` resolves a control's height to.
 */
function AddEntryActionSkeleton() {
  return <SkeletonBlock height="var(--size-touch-target)" className={styles.actionSkeleton} />;
}
