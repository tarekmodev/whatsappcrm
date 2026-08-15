import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { WorkflowsPanelSkeleton } from '@/features/workflows/components/WorkflowsPanel';

/**
 * Route-level skeleton, composed from the page's own section skeleton in the
 * order the page renders it.
 *
 * The action row is drawn unconditionally: this runs before the session is
 * resolved, so whether the principal holds `workflow:write` is not knowable yet,
 * and a skeleton that guessed would leave a gap that fills in a moment later.
 */
export default function WorkflowsLoading() {
  return (
    <Stack gap="5">
      <PageHeader title={content.workflows.title} subtitle={content.workflows.subtitle} />
      <WorkflowsPanelSkeleton />
    </Stack>
  );
}
