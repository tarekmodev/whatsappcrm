import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { Stack } from '@/components/layout/Stack';
import { PageHeader } from '@/components/shell/PageHeader';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * A link to a workflow that is gone — deleted, or one this tenant never had.
 *
 * A real, explanatory state rather than a silent redirect to the list: a
 * supervisor following a colleague's link needs to know the workflow was deleted,
 * not to land somewhere else and wonder whether they misread the URL.
 */
export default function WorkflowNotFound() {
  return (
    <Stack gap="5">
      <PageHeader title={content.workflows.title} />
      <EmptyState
        icon="automation"
        title={content.workflows.canvasNotFoundHeading}
        description={content.workflows.canvasNotFoundBody}
        action={
          <ButtonLink href={routes.settingsWorkflows()} variant="primary">
            {content.workflows.canvasBack}
          </ButtonLink>
        }
      />
    </Stack>
  );
}
