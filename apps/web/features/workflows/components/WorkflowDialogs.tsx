'use client';

import type { WorkflowResponse } from '@whatsappcrm/contracts';
import {
  LazyDeleteWorkflowDialog,
  LazyTestWorkflowDialog,
  LazyWorkflowRunsDialog,
} from './workflow-dialogs.lazy';

/**
 * Which dialog the workflow list has open, if any.
 *
 * A discriminated union rather than three independent `useState`s: only one
 * dialog can be open at a time, and three booleans can represent states that are
 * not reachable — which is how a modal ends up rendered behind another.
 *
 * **Editing is not among them.** It is a route now
 * (`/settings/workflows/{id}`), because a 16-node canvas does not fit a modal
 * and because which workflow is being edited is the most shareable state this
 * surface has. What is left here is the three panels that genuinely are per
 * workflow and per principal.
 */
export type OpenWorkflowDialog =
  | { readonly kind: 'delete'; readonly workflow: WorkflowResponse }
  | { readonly kind: 'test'; readonly workflow: WorkflowResponse }
  | { readonly kind: 'runs'; readonly workflow: WorkflowResponse }
  | null;

/**
 * Renders whichever dialog is open. Usage:
 * `<WorkflowDialogs dialog={dialog} onClose={…} />`.
 *
 * Each one is behind its own lazy boundary, so a supervisor who only wanted to
 * read the list downloads none of them — and opening the run history does not
 * pull in the dry run.
 */
export function WorkflowDialogs({
  dialog,
  onClose,
}: {
  dialog: OpenWorkflowDialog;
  onClose: () => void;
}) {
  if (dialog === null) {
    return null;
  }

  switch (dialog.kind) {
    case 'delete':
      return <LazyDeleteWorkflowDialog workflow={dialog.workflow} onClose={onClose} />;

    case 'test':
      return <LazyTestWorkflowDialog workflow={dialog.workflow} onClose={onClose} />;

    case 'runs':
      return <LazyWorkflowRunsDialog workflow={dialog.workflow} onClose={onClose} />;
  }
}
