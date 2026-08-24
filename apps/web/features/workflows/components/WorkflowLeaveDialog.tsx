'use client';

import { FormDialog } from '@/components/ui/FormDialog';
import { useContent } from '@/lib/content';

/**
 * Confirms leaving the canvas with unsaved changes. Usage:
 * `<WorkflowLeaveDialog onStay={…} onLeave={…} />` — rendered only when there is
 * something to lose.
 *
 * The canvas is a long editing session with no autosave (ADR 0009: this writes
 * to live tickets), so leaving it is the one irreversible thing the route can do
 * — there is no undo for a draft the browser has thrown away. `beforeunload` in
 * `useWorkflowEditor` covers a reload or a typed URL; this covers the two exits
 * the page itself offers.
 */
export function WorkflowLeaveDialog({
  onStay,
  onLeave,
}: {
  onStay: () => void;
  onLeave: () => void;
}) {
  const content = useContent();
  const copy = content.workflows;

  return (
    <FormDialog
      isOpen
      title={copy.canvasCancel}
      submitLabel={copy.canvasBack}
      submitVariant="danger"
      isPending={false}
      formError={null}
      onClose={onStay}
      onSubmit={onLeave}
    >
      <p>{copy.canvasLeaveConfirm}</p>
    </FormDialog>
  );
}
