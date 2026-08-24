import { content } from '@/content/en';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { WorkflowEditorPanelSkeleton } from '@/features/workflows/components/WorkflowEditorPanel';

/** Route-level skeleton, composed from the page's own section skeleton. */
export default function EditWorkflowLoading() {
  return (
    <Stack gap="5">
      <PageHeader title={content.workflows.title} subtitle={content.workflows.canvasEditSubtitle} />
      <WorkflowEditorPanelSkeleton />
    </Stack>
  );
}
