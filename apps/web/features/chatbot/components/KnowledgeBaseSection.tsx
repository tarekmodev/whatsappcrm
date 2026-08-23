import { Suspense, type ReactNode } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';
import { SkeletonBlock } from '@/components/ui/Skeleton';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import type { PermissionChecker } from '@/lib/session/permissions';
import { CHATBOT_SECTION_IDS } from '../constants';
import { AddKnowledgeEntryAction } from './AddKnowledgeEntryAction';
import { KnowledgeFilterBarSkeleton } from './KnowledgeFilterBar.Skeleton';
import { KnowledgeDocumentsTableSkeleton } from './KnowledgeDocumentsTable';
import { SourceHealthStripSkeleton } from './SourceHealthStrip';
import styles from './KnowledgeBaseSection.module.css';

/**
 * Stage A: what the chatbot is allowed to answer from. The card's frame, and
 * nothing that has to wait — the health strip, the filter row and the table each
 * arrive in their own boundary inside it.
 *
 * Called "Sources" on screen and `Knowledge*` in the code (TAR-813): the API
 * resource is `knowledge-documents` and half a renamed vocabulary is how the two
 * drift apart, but the rail names this stage Sources, so the card it links to
 * has to agree with the rail.
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
      id={CHATBOT_SECTION_IDS.sources}
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

export function KnowledgeBaseSectionSkeleton({ hasActions = true }: { hasActions?: boolean }) {
  return (
    <SectionCard
      id={CHATBOT_SECTION_IDS.sources}
      title={content.chatbot.knowledgeHeading}
      description={content.chatbot.knowledgeDescription}
      action={<AddEntryActionSkeleton />}
    >
      <Stack gap="4">
        <SourceHealthStripSkeleton />
        <KnowledgeFilterBarSkeleton />
        <KnowledgeDocumentsTableSkeleton hasActions={hasActions} />
      </Stack>
    </SectionCard>
  );
}

function AddEntryActionSkeleton() {
  return <SkeletonBlock height="var(--size-touch-target)" className={styles.actionSkeleton} />;
}
